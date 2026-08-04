import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Inject,
  Injectable,
  Optional
} from "@nestjs/common";
import { ConfigService } from "@nestjs/config";

import type {
  BackofficeRole,
  SystemSettingEntry,
  SystemSettingInputType,
  SystemSettingsSnapshot,
  SystemSettingsUpdatePayload,
  SystemSettingsUpdateResult
} from "@vm/shared-types";

import {
  assertPaymentDisablementStoreSafety,
  assertProductionConfigurationSafety,
  isProductionRuntime
} from "../../common/config/production-safety";
import {
  assertRuntimeDataPlaneExternalIntegrationPolicy,
  runtimeDataPlaneExternalIntegrationKeys
} from "../../common/config/runtime-data-plane-policy";
import { appendSystemAuditLog, resolveApiEnvFile } from "../../common/store/persistence";
import { InMemoryStoreService } from "../../common/store/in-memory-store.service";
import {
  PrivateConfigWriteError,
  writePrivateConfigFileAtomically
} from "../../common/store/private-config-file";
import { SystemAuditLogService } from "../../common/store/system-audit-log.service";
import { systemSettingCatalog } from "./system-settings.catalog";

interface EnvAssignment {
  key: string;
  value: string;
  lineIndex: number;
  group?: string;
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
const runtimeEnvironmentKeys = new Set(["NODE_ENV", "APP_ENV"]);
const instanceAdministratorSettingKeys = new Set([
  "VM_RESERVATION_ONLY_PICKUP",
  "SMARTVM_ADJUSTMENT_QUOTA_TIME_MODE"
]);
const fullSimulationAdministratorSettingKeys = new Set([
  "VM_FULL_SIMULATION_VERIFICATION_MODE",
  "VM_FULL_SIMULATION_PAYMENT_MODE"
]);
const truthySettingValues = new Set(["1", "true", "yes", "on"]);
const runtimeDataPlaneExternalIntegrationKeySet = new Set<string>(
  runtimeDataPlaneExternalIntegrationKeys
);
// 这些路径共同定义一份运行态快照。在线切换任一项都会让审计、账本、上传或维护命令
// 落到不同位置，必须在停服维护窗口通过受控部署配置统一修改。
const liveRuntimeStorageBoundaryKeys = new Set([
  "VM_DATA_PLANE",
  "VM_DATA_ROOT",
  "VM_DATA_PLANE_ID",
  "VM_PLATFORM_TENANT_NAME",
  "API_DATA_FILE",
  "SYSTEM_LOG_FILE",
  "UPLOAD_DIR",
  "API_BACKUP_DIR",
  "FINANCIAL_SINGLE_WRITER_LEASE_FILE"
]);

@Injectable()
export class SystemSettingsService {
  private readonly envFilePath: string;
  private readonly auditLog: SystemAuditLogService;
  /** live 平面只有部署层显式注入受控写入适配器时才允许写配置，默认 .env 永远只读。 */
  private readonly hasManagedLiveConfigWriter: boolean;

  constructor(
    @Inject(ConfigService) private readonly configService: ConfigService,
    @Optional()
    @Inject(SYSTEM_SETTINGS_RUNTIME_ADAPTER)
    runtimeAdapter?: SystemSettingsRuntimeAdapter,
    @Optional()
    @Inject(SystemAuditLogService)
    auditLog?: SystemAuditLogService,
    @Optional()
    @Inject(InMemoryStoreService)
    private readonly store?: InMemoryStoreService
  ) {
    this.envFilePath = runtimeAdapter?.envFilePath ?? resolveApiEnvFile();
    this.hasManagedLiveConfigWriter = Boolean(runtimeAdapter?.envFilePath);
    this.auditLog = auditLog ?? new SystemAuditLogService({
      appendAuditLog: runtimeAdapter?.appendAuditLog ?? appendSystemAuditLog
    });
  }

  getSettings(options?: {
    includeSensitiveValues?: boolean;
    actorBackofficeRole?: BackofficeRole;
  }): SystemSettingsSnapshot {
    const envFilePath = this.envFilePath;
    const exampleFilePath = this.resolveExampleFilePath(envFilePath);
    const envFile = this.parseEnvFile(envFilePath);
    const exampleFile = this.parseEnvFile(exampleFilePath);
    const keys = this.collectSettingKeys(envFile, exampleFile);

    const settings = keys.map((key) =>
      this.createSettingEntry(key, envFile, exampleFile, options)
    );

    return {
      envFilePath,
      exampleFilePath: existsSync(exampleFilePath) ? exampleFilePath : undefined,
      loadedAt: new Date().toISOString(),
      settings: this.filterSettingsForActor(settings, options?.actorBackofficeRole)
    };
  }

  updateSettings(
    payload: SystemSettingsUpdatePayload,
    options?: {
      includeSensitiveValues?: boolean;
      actorBackofficeRole?: BackofficeRole;
    }
  ): SystemSettingsUpdateResult {
    if (
      this.configService.get<string>("VM_DATA_PLANE")?.trim().toLowerCase() === "live" &&
      !this.hasManagedLiveConfigWriter
    ) {
      throw new BadRequestException(
        "真实数据平面禁止通过后台写入默认 .env；请由部署系统或密钥管理器注入受控配置。"
      );
    }

    if (!payload || typeof payload.values !== "object" || Array.isArray(payload.values)) {
      throw new BadRequestException("配置保存参数不正确。");
    }

    const snapshotBefore = this.getSettings({ includeSensitiveValues: true });
    const entriesByKey = new Map(snapshotBefore.settings.map((entry) => [entry.key, entry]));
    const nextValues = new Map<string, string>();

    this.assertActorCanUpdateKeys(
      Object.keys(payload.values),
      snapshotBefore.settings,
      options?.actorBackofficeRole
    );

    if (!options?.includeSensitiveValues) {
      const sensitiveKey = Object.keys(payload.values).find((key) => entriesByKey.get(key)?.sensitive);

      if (sensitiveKey) {
        throw new BadRequestException(`当前账号不能修改敏感配置项：${sensitiveKey}`);
      }
    }

    for (const entry of snapshotBefore.settings) {
      const isExplicitlyUpdated = Object.prototype.hasOwnProperty.call(
        payload.values,
        entry.key
      );
      const rawValue = isExplicitlyUpdated ? payload.values[entry.key] : entry.value;

      // PATCH 只校验本次准备写入的字段。未改动的历史配置仍会作为完整候选
      // 交给跨字段与数据平面门禁复核，避免保存一个示例选项时被未启用服务的
      // 必填项阻断。
      nextValues.set(
        entry.key,
        isExplicitlyUpdated
          ? this.normalizeSettingValue(entry, rawValue ?? "")
          : rawValue ?? ""
      );
    }

    for (const key of Object.keys(payload.values)) {
      if (!envKeyPattern.test(key) || !entriesByKey.has(key)) {
        throw new BadRequestException(`不支持的配置项：${key}`);
      }
    }

    this.assertCrossSettingConstraints(nextValues);

    // 无论 NODE_ENV/APP_ENV 为何，候选配置都必须先满足当前数据平面的外部集成边界。
    // 这样后台保存不能绕过启动门禁，将 mock/真实渠道错误写入运行时或配置文件。
    assertRuntimeDataPlaneExternalIntegrationPolicy(
      Object.fromEntries(
        runtimeDataPlaneExternalIntegrationKeys.map((key) => [
          key,
          nextValues.get(key) ?? this.configService.get<string>(key)
        ])
      )
    );

    const changedKeys = snapshotBefore.settings
      .filter((entry) => entry.value !== nextValues.get(entry.key))
      .map((entry) => entry.key);

    if (
      changedKeys.some((key) => liveRuntimeStorageBoundaryKeys.has(key))
    ) {
      throw new BadRequestException(
        "运行中不能切换运行数据、当前实例身份、审计、上传、备份或金融租约路径；必须先停止 API 和运行数据维护命令，再通过受控配置变更统一修改并重启。"
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

    if (isProductionRuntime()) {
      const candidateConfigService = {
        get: (key: string) =>
          nextValues.has(key) ? nextValues.get(key) : this.configService.get(key)
      } as unknown as ConfigService;

      assertProductionConfigurationSafety(candidateConfigService);
      assertPaymentDisablementStoreSafety(candidateConfigService, this.store);
    }

    const restartRequiredKeys = changedKeys.filter(
      (key) =>
        entriesByKey.get(key)?.restartRequired ||
        runtimeDataPlaneExternalIntegrationKeySet.has(key)
    );
    const runtimeAppliedKeys = changedKeys.filter(
      (key) =>
        !entriesByKey.get(key)?.restartRequired &&
        !runtimeDataPlaneExternalIntegrationKeySet.has(key)
    );
    const criticalAudit = isProductionRuntime()
      ? this.auditLog.beginCriticalIntent({
          method: "PATCH",
          path: "/api/system-settings",
          metadata: {
            action: "update-system-settings",
            changedKeys,
            runtimeAppliedKeys,
            restartRequiredKeys
          }
        })
      : undefined;

    let configFileCommitted = false;

    try {
      this.writeEnvFile(nextValues);
      configFileCommitted = true;

      for (const key of runtimeAppliedKeys) {
        this.configService.set(key, nextValues.get(key));
      }

      const updatedAt = new Date().toISOString();
      const result = {
        ...this.getSettings(options),
        updatedAt,
        changedKeys,
        runtimeAppliedKeys,
        restartRequiredKeys
      };

      if (criticalAudit) {
        this.auditLog.completeCriticalOperation(criticalAudit, {
          method: "PATCH",
          path: "/api/system-settings",
          statusCode: 200,
          durationMs: Date.now() - criticalAudit.startedAt,
          outcome: "completed",
          metadata: {
            action: "update-system-settings",
            changedKeys,
            runtimeAppliedKeys,
            restartRequiredKeys
          }
        });
      } else {
        this.auditLog.appendSafely({
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
      }

      return result;
    } catch (error) {
      const operationIndeterminate =
        configFileCommitted ||
        (error instanceof PrivateConfigWriteError && error.committed);

      if (criticalAudit) {
        this.auditLog.completeCriticalOperation(criticalAudit, {
          method: "PATCH",
          path: "/api/system-settings",
          statusCode: operationIndeterminate ? 409 : 500,
          durationMs: Date.now() - criticalAudit.startedAt,
          outcome: operationIndeterminate ? "indeterminate" : "failed",
          metadata: {
            action: "update-system-settings",
            retryable: !operationIndeterminate
          }
        });
      }

      if (operationIndeterminate && criticalAudit) {
        throw new ConflictException({
          message: "配置更新状态暂不可确认，请勿重复提交；请联系管理员核对。",
          code: "operation_indeterminate",
          operationId: criticalAudit.operationId,
          retryable: false
        });
      }
      throw error;
    }
  }

  private filterSettingsForActor(
    settings: SystemSettingEntry[],
    actorBackofficeRole?: BackofficeRole
  ) {
    if (!actorBackofficeRole || actorBackofficeRole === "super_admin") {
      return settings;
    }

    if (actorBackofficeRole !== "admin") {
      return [];
    }

    const allowedKeys = new Set(instanceAdministratorSettingKeys);

    if (this.isEnabledFullSimulation(settings)) {
      for (const key of fullSimulationAdministratorSettingKeys) {
        allowedKeys.add(key);
      }
    }

    return settings.filter((entry) => allowedKeys.has(entry.key));
  }

  private assertActorCanUpdateKeys(
    keys: string[],
    settings: SystemSettingEntry[],
    actorBackofficeRole?: BackofficeRole
  ) {
    if (!actorBackofficeRole || actorBackofficeRole === "super_admin") {
      return;
    }

    const allowedKeys = new Set(
      this.filterSettingsForActor(settings, actorBackofficeRole).map((entry) => entry.key)
    );

    if (keys.some((key) => !allowedKeys.has(key))) {
      throw new ForbiddenException(
        "实例管理员只能维护日常实例设置；登录、短信、密钥和运行配置由服务提供商维护。"
      );
    }
  }

  private isEnabledFullSimulation(settings: SystemSettingEntry[]) {
    const values = new Map(
      settings.map((entry) => [entry.key, entry.value.trim()])
    );

    return (
      values.get("VM_DATA_PLANE") === "simulation" &&
      values.get("VM_SIMULATION_PROFILE") === "full" &&
      truthySettingValues.has(
        values.get("VM_FULL_SIMULATION_ENABLED")?.toLowerCase() ?? ""
      ) &&
      Boolean(values.get("VM_DATA_ROOT")) &&
      Boolean(values.get("VM_DATA_PLANE_ID"))
    );
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
    const group = metadata?.group ?? envFile.groups.get(key) ?? exampleFile.groups.get(key) ?? defaultGroupName;
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
    writePrivateConfigFileAtomically(envFilePath, nextContent);
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
    let currentGroup: string | undefined;

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
      if (entry.group) {
        groups.set(entry.key, entry.group);
      }
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
    const match = line.match(/^\s*#\s*分组\s*[:：]\s*(.+?)\s*$/);

    if (!match?.[1]) {
      return undefined;
    }

    return match[1].trim() || defaultGroupName;
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
