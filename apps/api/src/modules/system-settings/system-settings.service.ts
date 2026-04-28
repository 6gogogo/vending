import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { BadRequestException, Inject, Injectable } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";

import type {
  SystemSettingEntry,
  SystemSettingInputType,
  SystemSettingsSnapshot,
  SystemSettingsUpdatePayload,
  SystemSettingsUpdateResult
} from "@vm/shared-types";

import { appendSystemAuditLog, resolveApiEnvFile } from "../../common/store/persistence";
import { systemSettingCatalog } from "./system-settings.catalog";

interface EnvAssignment {
  key: string;
  value: string;
  lineIndex: number;
  group: string;
}

interface ParsedEnvFile {
  filePath: string;
  lines: string[];
  assignments: EnvAssignment[];
  values: Map<string, string>;
  groups: Map<string, string>;
}

const defaultGroupName = "其他配置";
const envKeyPattern = /^[A-Z][A-Z0-9_]*$/;

@Injectable()
export class SystemSettingsService {
  constructor(@Inject(ConfigService) private readonly configService: ConfigService) {}

  getSettings(): SystemSettingsSnapshot {
    const envFilePath = resolveApiEnvFile();
    const exampleFilePath = this.resolveExampleFilePath(envFilePath);
    const envFile = this.parseEnvFile(envFilePath);
    const exampleFile = this.parseEnvFile(exampleFilePath);
    const keys = this.collectSettingKeys(envFile, exampleFile);

    return {
      envFilePath,
      exampleFilePath: existsSync(exampleFilePath) ? exampleFilePath : undefined,
      loadedAt: new Date().toISOString(),
      settings: keys.map((key) => this.createSettingEntry(key, envFile, exampleFile))
    };
  }

  updateSettings(payload: SystemSettingsUpdatePayload): SystemSettingsUpdateResult {
    if (!payload || typeof payload.values !== "object" || Array.isArray(payload.values)) {
      throw new BadRequestException("配置保存参数不正确。");
    }

    const snapshotBefore = this.getSettings();
    const entriesByKey = new Map(snapshotBefore.settings.map((entry) => [entry.key, entry]));
    const nextValues = new Map<string, string>();

    for (const entry of snapshotBefore.settings) {
      const rawValue = Object.prototype.hasOwnProperty.call(payload.values, entry.key)
        ? payload.values[entry.key]
        : entry.value;
      nextValues.set(entry.key, this.normalizeSettingValue(entry, rawValue ?? ""));
    }

    for (const key of Object.keys(payload.values)) {
      if (!envKeyPattern.test(key) || !entriesByKey.has(key)) {
        throw new BadRequestException(`不支持的配置项：${key}`);
      }
    }

    const changedKeys = snapshotBefore.settings
      .filter((entry) => entry.value !== nextValues.get(entry.key))
      .map((entry) => entry.key);

    this.writeEnvFile(nextValues);

    for (const [key, value] of nextValues) {
      this.configService.set(key, value);
    }

    const restartRequiredKeys = changedKeys.filter(
      (key) => entriesByKey.get(key)?.restartRequired
    );
    const runtimeAppliedKeys = changedKeys.filter(
      (key) => !entriesByKey.get(key)?.restartRequired
    );
    const updatedAt = new Date().toISOString();

    appendSystemAuditLog({
      occurredAt: updatedAt,
      method: "PATCH",
      path: "/api/system-settings",
      statusCode: 200,
      durationMs: 0,
      metadata: {
        changedKeys,
        runtimeAppliedKeys,
        restartRequiredKeys
      }
    });

    return {
      ...this.getSettings(),
      updatedAt,
      changedKeys,
      runtimeAppliedKeys,
      restartRequiredKeys
    };
  }

  private createSettingEntry(
    key: string,
    envFile: ParsedEnvFile,
    exampleFile: ParsedEnvFile
  ): SystemSettingEntry {
    const metadata = systemSettingCatalog[key];
    const envValue = envFile.values.get(key);
    const exampleValue = exampleFile.values.get(key);
    const runtimeValue = this.configService.get<string>(key);
    const value = envValue ?? runtimeValue ?? exampleValue ?? "";
    const source: SystemSettingEntry["source"] =
      envValue !== undefined
        ? "env"
        : exampleValue !== undefined && runtimeValue === exampleValue
          ? "example"
          : runtimeValue !== undefined
            ? "runtime"
            : "example";
    const group = envFile.groups.get(key) ?? exampleFile.groups.get(key) ?? defaultGroupName;
    const inputType = this.resolveInputType(key, value, exampleValue, metadata?.inputType);

    return {
      key,
      value,
      exampleValue,
      group,
      label: metadata?.label ?? this.toReadableLabel(key),
      description: metadata?.description ?? `${group}配置项。`,
      inputType,
      options: metadata?.options,
      sensitive: metadata?.sensitive ?? this.isSensitiveKey(key),
      required: metadata?.required ?? false,
      restartRequired: metadata?.restartRequired ?? false,
      source,
      effectiveValue: runtimeValue ?? value
    };
  }

  private writeEnvFile(values: Map<string, string>) {
    const envFilePath = resolveApiEnvFile();
    const exampleFilePath = this.resolveExampleFilePath(envFilePath);
    const envFile = this.parseEnvFile(envFilePath);
    const exampleFile = this.parseEnvFile(exampleFilePath);
    const templateFile = exampleFile.assignments.length > 0 ? exampleFile : envFile;
    const templatedKeys = new Set<string>();
    const nextLines = templateFile.lines.map((line) => {
      const assignment = this.parseAssignmentLine(line);

      if (!assignment || !values.has(assignment.key)) {
        return line;
      }

      templatedKeys.add(assignment.key);
      return `${assignment.key}=${this.encodeEnvValue(values.get(assignment.key) ?? "")}`;
    });

    const extraKeys = [...values.keys()].filter((key) => !templatedKeys.has(key)).sort();

    if (extraKeys.length > 0) {
      if (nextLines.length > 0 && nextLines[nextLines.length - 1]?.trim()) {
        nextLines.push("");
      }

      nextLines.push(`# ${defaultGroupName}`);
      for (const key of extraKeys) {
        nextLines.push(`${key}=${this.encodeEnvValue(values.get(key) ?? "")}`);
      }
    }

    const nextContent = `${nextLines.join("\n").replace(/\s*$/, "")}\n`;
    mkdirSync(dirname(envFilePath), { recursive: true });
    writeFileSync(envFilePath, nextContent, "utf8");
  }

  private normalizeSettingValue(entry: SystemSettingEntry, value: string) {
    const trimmed = String(value ?? "").trim();

    if (entry.required && !trimmed) {
      throw new BadRequestException(`${entry.label}不能为空。`);
    }

    if (entry.inputType === "boolean") {
      return this.normalizeBooleanValue(trimmed);
    }

    if (entry.inputType === "select") {
      const options = entry.options ?? [];

      if (!options.some((option) => option.value === trimmed)) {
        throw new BadRequestException(`${entry.label}不是有效选项。`);
      }

      return trimmed;
    }

    if (entry.inputType === "number" && trimmed) {
      const numericValue = Number(trimmed);

      if (!Number.isFinite(numericValue)) {
        throw new BadRequestException(`${entry.label}必须是数字。`);
      }

      if (entry.key === "PORT") {
        if (!Number.isInteger(numericValue) || numericValue < 1 || numericValue > 65535) {
          throw new BadRequestException("API 服务端口必须是 1-65535 之间的整数。");
        }
      }

      if (entry.key === "BUSINESS_DAY_START_HOUR") {
        if (!Number.isInteger(numericValue) || numericValue < 0 || numericValue > 23) {
          throw new BadRequestException("业务日起始小时必须是 0-23 之间的整数。");
        }
      }

      if (entry.key === "BUSINESS_TIMEZONE_OFFSET_HOURS") {
        if (numericValue < -12 || numericValue > 14) {
          throw new BadRequestException("业务时区偏移需在 -12 到 14 之间。");
        }
      }
    }

    return entry.inputType === "textarea" ? String(value ?? "").replace(/\r\n/g, "\n") : trimmed;
  }

  private normalizeBooleanValue(value: string) {
    if (["1", "true", "yes", "on"].includes(value.toLowerCase())) {
      return "true";
    }

    if (!value || ["0", "false", "no", "off"].includes(value.toLowerCase())) {
      return "false";
    }

    throw new BadRequestException("布尔配置只能填写 true 或 false。");
  }

  private collectSettingKeys(envFile: ParsedEnvFile, exampleFile: ParsedEnvFile) {
    return [
      ...new Set([
        ...exampleFile.assignments.map((assignment) => assignment.key),
        ...envFile.assignments.map((assignment) => assignment.key)
      ])
    ].filter((key) => envKeyPattern.test(key));
  }

  private parseEnvFile(filePath: string): ParsedEnvFile {
    const content = existsSync(filePath) ? readFileSync(filePath, "utf8") : "";
    const lines = content ? content.replace(/\r\n/g, "\n").split("\n") : [];
    const assignments: EnvAssignment[] = [];
    const values = new Map<string, string>();
    const groups = new Map<string, string>();
    let currentGroup = defaultGroupName;

    lines.forEach((line, lineIndex) => {
      const sectionName = this.parseSectionName(line);

      if (sectionName) {
        currentGroup = sectionName;
        return;
      }

      const assignment = this.parseAssignmentLine(line);

      if (!assignment) {
        return;
      }

      const entry = {
        ...assignment,
        lineIndex,
        group: currentGroup
      };

      assignments.push(entry);
      values.set(entry.key, entry.value);
      groups.set(entry.key, entry.group);
    });

    return {
      filePath,
      lines,
      assignments,
      values,
      groups
    };
  }

  private parseSectionName(line: string) {
    const match = line.match(/^\s*#\s*(.+?)\s*$/);

    if (!match?.[1]) {
      return undefined;
    }

    return match[1].split(/[:：]/)[0]?.trim() || defaultGroupName;
  }

  private parseAssignmentLine(line: string) {
    const match = line.match(/^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/);

    if (!match?.[1]) {
      return undefined;
    }

    return {
      key: match[1],
      value: this.decodeEnvValue(this.stripInlineComment(match[2] ?? ""))
    };
  }

  private stripInlineComment(value: string) {
    let quote: string | undefined;
    let escaped = false;

    for (let index = 0; index < value.length; index += 1) {
      const char = value[index];

      if (escaped) {
        escaped = false;
        continue;
      }

      if (quote && char === "\\") {
        escaped = true;
        continue;
      }

      if (quote) {
        if (char === quote) {
          quote = undefined;
        }
        continue;
      }

      if (char === "\"" || char === "'" || char === "`") {
        quote = char;
        continue;
      }

      if (char === "#" && (index === 0 || /\s/.test(value[index - 1] ?? ""))) {
        return value.slice(0, index).trimEnd();
      }
    }

    return value.trimEnd();
  }

  private decodeEnvValue(rawValue: string) {
    const trimmed = rawValue.trim();

    if (!trimmed) {
      return "";
    }

    if (trimmed.startsWith("\"") && trimmed.endsWith("\"")) {
      try {
        return String(JSON.parse(trimmed));
      } catch {
        return trimmed.slice(1, -1);
      }
    }

    if (
      (trimmed.startsWith("'") && trimmed.endsWith("'")) ||
      (trimmed.startsWith("`") && trimmed.endsWith("`"))
    ) {
      return trimmed.slice(1, -1);
    }

    return trimmed;
  }

  private encodeEnvValue(value: string) {
    const normalized = String(value ?? "").replace(/\r\n/g, "\n");

    if (!normalized) {
      return "";
    }

    if (/[\s#"'`]/.test(normalized)) {
      return JSON.stringify(normalized);
    }

    return normalized;
  }

  private resolveInputType(
    key: string,
    value: string,
    exampleValue: string | undefined,
    configuredType: SystemSettingInputType | undefined
  ): SystemSettingInputType {
    if (configuredType) {
      return configuredType;
    }

    if (value.includes("\n") || key.includes("PRIVATE_KEY") || key.includes("PUBLIC_KEY")) {
      return "textarea";
    }

    if (this.isSensitiveKey(key)) {
      return "password";
    }

    const comparableValue = value || exampleValue || "";

    if (this.looksBoolean(key, comparableValue)) {
      return "boolean";
    }

    if (this.looksNumeric(key, comparableValue)) {
      return "number";
    }

    if (key.endsWith("_URL") || key === "PUBLIC_BASE_URL") {
      return "url";
    }

    if (key.endsWith("_PATH") || key.endsWith("_FILE") || key.endsWith("_DIR")) {
      return "path";
    }

    return "text";
  }

  private looksBoolean(key: string, value: string) {
    return (
      key.endsWith("_ENABLED") ||
      key.startsWith("ENABLE_") ||
      ["true", "false", "1", "0", "yes", "no", "on", "off"].includes(value.toLowerCase())
    );
  }

  private looksNumeric(key: string, value: string) {
    return (
      ["PORT"].includes(key) ||
      key.endsWith("_MS") ||
      key.endsWith("_HOUR") ||
      key.endsWith("_HOURS") ||
      key.endsWith("_NUM") ||
      key.endsWith("_STYLE") ||
      (!!value && Number.isFinite(Number(value)))
    );
  }

  private isSensitiveKey(key: string) {
    return /(?:API_KEY|ACCESS_KEY|SECRET|PRIVATE_KEY|PUBLIC_KEY|SMARTVM_KEY|CERT_SERIAL|DATABASE_URL)/.test(key);
  }

  private toReadableLabel(key: string) {
    return key
      .split("_")
      .map((part) => part.slice(0, 1) + part.slice(1).toLowerCase())
      .join(" ");
  }

  private resolveExampleFilePath(envFilePath: string) {
    return resolve(dirname(envFilePath), ".env.example");
  }
}
