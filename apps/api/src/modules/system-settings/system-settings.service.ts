import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { BadRequestException, Inject, Injectable, Optional } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";

import type {
  SystemSettingEntry,
  SystemSettingInputType,
  SystemSettingsSnapshot,
  SystemSettingsUpdatePayload,
  SystemSettingsUpdateResult
} from "@vm/shared-types";

import {
  assertProductionConfigurationSafety,
  isProductionRuntime,
  productionConfigurationSafetyCriticalKeys
} from "../../common/config/production-safety";
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

interface SystemSettingsRuntimeAdapter {
  envFilePath?: string;
  appendAuditLog?: typeof appendSystemAuditLog;
}

export const SYSTEM_SETTINGS_RUNTIME_ADAPTER = Symbol(
  "SYSTEM_SETTINGS_RUNTIME_ADAPTER"
);

const defaultGroupName = "其他配置";
const envKeyPattern = /^[A-Z][A-Z0-9_]*$/;
const productionConfigurationSafetyCriticalKeySet = new Set<string>(
  productionConfigurationSafetyCriticalKeys
);
const runtimeEnvironmentKeys = new Set(["NODE_ENV", "APP_ENV"]);
// 其他运行数据路径仍受当前租约路径保护；唯独在线切换租约文件会让新维护进程
// 竞争另一把锁，从而与仍持有旧锁的 API 同时写同一账本。
const liveCoordinationBoundaryKeys = new Set([
  "FINANCIAL_SINGLE_WRITER_LEASE_FILE"
]);

@Injectable()
export class SystemSettingsService {
  private readonly envFilePath: string;
  private readonly appendAuditLog: typeof appendSystemAuditLog;

  constructor(
    @Inject(ConfigService) private readonly configService: ConfigService,
    @Optional()
    @Inject(SYSTEM_SETTINGS_RUNTIME_ADAPTER)
    runtimeAdapter?: SystemSettingsRuntimeAdapter
  ) {
    this.envFilePath = runtimeAdapter?.envFilePath ?? resolveApiEnvFile();
    this.appendAuditLog = runtimeAdapter?.appendAuditLog ?? appendSystemAuditLog;
  }

  getSettings(options?: { includeSensitiveValues?: boolean }): SystemSettingsSnapshot {
    const envFilePath = this.envFilePath;
    const exampleFilePath = this.resolveExampleFilePath(envFilePath);
    const envFile = this.parseEnvFile(envFilePath);
    const exampleFile = this.parseEnvFile(exampleFilePath);
    const keys = this.collectSettingKeys(envFile, exampleFile);

    return {
      envFilePath,
      exampleFilePath: existsSync(exampleFilePath) ? exampleFilePath : undefined,
      loadedAt: new Date().toISOString(),
      settings: keys.map((key) => this.createSettingEntry(key, envFile, exampleFile, options))
    };
  }

  updateSettings(
    payload: SystemSettingsUpdatePayload,
    options?: { includeSensitiveValues?: boolean }
  ): SystemSettingsUpdateResult {
    if (!payload || typeof payload.values !== "object" || Array.isArray(payload.values)) {
      throw new BadRequestException("配置保存参数不正确。");
    }

    const snapshotBefore = this.getSettings({ includeSensitiveValues: true });
    const entriesByKey = new Map(snapshotBefore.settings.map((entry) => [entry.key, entry]));
    const nextValues = new Map<string, string>();

    if (!options?.includeSensitiveValues) {
      const sensitiveKey = Object.keys(payload.values).find((key) => entriesByKey.get(key)?.sensitive);

      if (sensitiveKey) {
        throw new BadRequestException(`当前账号不能修改敏感配置项：${sensitiveKey}`);
      }
    }

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

    this.assertCrossSettingConstraints(nextValues);

    const changedKeys = snapshotBefore.settings
      .filter((entry) => entry.value !== nextValues.get(entry.key))
      .map((entry) => entry.key);

    if (
      changedKeys.some((key) => liveCoordinationBoundaryKeys.has(key))
    ) {
      throw new BadRequestException(
        "运行中不能切换金融单写者租约文件；必须先停止 API 和运行数据维护命令，再通过受控配置变更统一修改并重启。"
      );
    }

    if (
      isProductionRuntime() &&
      changedKeys.some((key) => runtimeEnvironmentKeys.has(key))
    ) {
      throw new BadRequestException(
        "生产运行中不能在线修改 NODE_ENV 或 APP_ENV；请由受控部署环境管理运行模式。"
      );
    }

    if (
      isProductionRuntime() &&
      changedKeys.some((key) =>
        productionConfigurationSafetyCriticalKeySet.has(key)
      )
    ) {
      const candidateConfigService = {
        get: (key: string) =>
          nextValues.has(key) ? nextValues.get(key) : this.configService.get(key)
      } as unknown as ConfigService;

      assertProductionConfigurationSafety(candidateConfigService);
    }

    const restartRequiredKeys = changedKeys.filter(
      (key) => entriesByKey.get(key)?.restartRequired
    );
    const runtimeAppliedKeys = changedKeys.filter(
      (key) => !entriesByKey.get(key)?.restartRequired
    );

    this.writeEnvFile(nextValues);

    for (const key of runtimeAppliedKeys) {
      this.configService.set(key, nextValues.get(key));
    }

    const updatedAt = new Date().toISOString();

    this.appendAuditLog({
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
      ...this.getSettings(options),
      updatedAt,
      changedKeys,
      runtimeAppliedKeys,
      restartRequiredKeys
    };
  }

  private createSettingEntry(
    key: string,
    envFile: ParsedEnvFile,
    exampleFile: ParsedEnvFile,
    options?: { includeSensitiveValues?: boolean }
  ): SystemSettingEntry {
    const metadata = systemSettingCatalog[key];
    const envValue = envFile.values.get(key);
    const exampleValue = exampleFile.values.get(key);
    const runtimeValue = this.configService.get<string>(key);
    const value = envValue ?? runtimeValue ?? exampleValue ?? "";
    const sensitive = metadata?.sensitive ?? this.isSensitiveKey(key);
    const masked = sensitive && !options?.includeSensitiveValues && Boolean(value);
    const displayValue = masked ? "********" : value;
    const runtimeDisplayValue = sensitive && !options?.includeSensitiveValues && Boolean(runtimeValue ?? value)
      ? "********"
      : (runtimeValue ?? value);
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
      value: displayValue,
      exampleValue,
      group,
      label: metadata?.label ?? this.toReadableLabel(key),
      description: metadata?.description ?? `${group}配置项。`,
      inputType,
      options: metadata?.options,
      numberConstraints: metadata?.numberConstraints,
      sensitive,
      masked,
      required: metadata?.required ?? false,
      restartRequired: metadata?.restartRequired ?? false,
      source,
      effectiveValue: runtimeDisplayValue
    };
  }

  private writeEnvFile(values: Map<string, string>) {
    const envFilePath = this.envFilePath;
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

      const constraints = entry.numberConstraints;
      if (constraints?.integerOnly && !Number.isSafeInteger(numericValue)) {
        throw new BadRequestException(`${entry.label}必须是整数。`);
      }
      if (constraints?.min !== undefined && numericValue < constraints.min) {
        throw new BadRequestException(
          `${entry.label}不能小于 ${constraints.min}。`
        );
      }
      if (constraints?.max !== undefined && numericValue > constraints.max) {
        throw new BadRequestException(
          `${entry.label}不能大于 ${constraints.max}。`
        );
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

  private assertCrossSettingConstraints(values: Map<string, string>) {
    const initialDelay = this.readOptionalNumericSetting(
      values,
      "PAYMENT_RECONCILIATION_INITIAL_DELAY_MS"
    );
    const maxDelay = this.readOptionalNumericSetting(
      values,
      "PAYMENT_RECONCILIATION_MAX_DELAY_MS"
    );

    if (
      initialDelay !== undefined &&
      maxDelay !== undefined &&
      initialDelay > maxDelay
    ) {
      throw new BadRequestException(
        "支付对账首次等待毫秒不能大于支付对账最大退避毫秒。"
      );
    }
  }

  private readOptionalNumericSetting(values: Map<string, string>, key: string) {
    const raw = values.get(key)?.trim();
    return raw ? Number(raw) : undefined;
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
