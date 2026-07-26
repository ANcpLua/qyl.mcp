import {
  useCallback,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from "react";
import {
  appendJsonPointer,
  defaultsForSchema,
  formatJson,
  initialValueForSchema,
  parseJsonValue,
  validateJsonSchema,
  type JsonSchema,
  type JsonSchemaType,
  type JsonValue,
  type SchemaValidationIssue,
} from "./schema.js";

export interface SchemaFormProps {
  schema: JsonSchema;
  value: JsonValue;
  onChange: (value: JsonValue) => void;
  issues?: readonly SchemaValidationIssue[];
  idPrefix?: string;
  disabled?: boolean;
}

interface SchemaFieldProps {
  schema: JsonSchema;
  value: JsonValue | undefined;
  onChange: (value: JsonValue | undefined) => void;
  pointer: string;
  label: string;
  required: boolean;
  issues: readonly SchemaValidationIssue[];
  idPrefix: string;
  disabled: boolean;
}

function objectValue(value: JsonValue | undefined): Record<string, JsonValue> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value
    : {};
}

function schemaTypes(schema: JsonSchema): readonly JsonSchemaType[] {
  if (typeof schema.type === "string") return [schema.type];
  if (schema.type) return schema.type;
  if (schema.properties) return ["object"];
  if (schema.items) return ["array"];
  return [];
}

function typeOfValue(value: JsonValue | undefined): JsonSchemaType | undefined {
  if (value === undefined) return undefined;
  if (value === null) return "null";
  if (Array.isArray(value)) return "array";
  if (typeof value === "number") return Number.isInteger(value) ? "integer" : "number";
  if (typeof value === "object") return "object";
  if (typeof value === "string") return "string";
  if (typeof value === "boolean") return "boolean";
  return undefined;
}

function preferredType(schema: JsonSchema, value: JsonValue | undefined): JsonSchemaType {
  const actual = typeOfValue(value);
  const types = schemaTypes(schema);
  if (actual && (types.includes(actual) || (actual === "integer" && types.includes("number")))) {
    return actual;
  }
  return types.find((type) => type !== "null") ?? types[0] ?? "string";
}

function domToken(value: string): string {
  return [...value]
    .map((character) => /[a-zA-Z0-9_-]/u.test(character)
      ? character
      : `_${character.codePointAt(0)!.toString(16)}_`)
    .join("");
}

function controlId(idPrefix: string, pointer: string): string {
  return `${domToken(idPrefix)}-${pointer === "" ? "root" : domToken(pointer)}`;
}

function issuesAt(
  issues: readonly SchemaValidationIssue[],
  pointer: string,
): readonly SchemaValidationIssue[] {
  return issues.filter((entry) => entry.pointer === pointer);
}

function describedBy(...ids: Array<string | undefined>): string | undefined {
  const present = ids.filter((id): id is string => Boolean(id));
  return present.length > 0 ? present.join(" ") : undefined;
}

function FieldMessages({
  description,
  fieldIssues,
  descriptionId,
  errorId,
}: {
  description?: string | undefined;
  fieldIssues: readonly SchemaValidationIssue[];
  descriptionId: string;
  errorId: string;
}) {
  return (
    <>
      {description ? <small id={descriptionId}>{description}</small> : null}
      {fieldIssues.length > 0 ? (
        <ul id={errorId} aria-live="polite">
          {fieldIssues.map((entry, index) => (
            <li key={`${entry.keyword}-${index}`}>{entry.message}</li>
          ))}
        </ul>
      ) : null}
    </>
  );
}

function FieldFrame({
  label,
  required,
  controlId,
  control,
  messages,
}: {
  label: string;
  required: boolean;
  controlId: string;
  control: ReactNode;
  messages: ReactNode;
}) {
  return (
    <div className="schema-field">
      <label className="schema-field-label" htmlFor={controlId}>
        {label}
        {required ? <span aria-label="required"> *</span> : null}
      </label>
      {control}
      {messages}
    </div>
  );
}

function SchemaField({
  schema,
  value,
  onChange,
  pointer,
  label,
  required,
  issues,
  idPrefix,
  disabled,
}: SchemaFieldProps) {
  const id = controlId(idPrefix, pointer);
  const descriptionId = `${id}-description`;
  const errorId = `${id}-errors`;
  const fieldIssues = issuesAt(issues, pointer);
  const ariaDescribedBy = describedBy(
    schema.description ? descriptionId : undefined,
    fieldIssues.length > 0 ? errorId : undefined,
  );
  const invalid = fieldIssues.length > 0;

  const messages = (
    <FieldMessages
      description={schema.description}
      fieldIssues={fieldIssues}
      descriptionId={descriptionId}
      errorId={errorId}
    />
  );

  if (schema.const !== undefined) {
    return (
      <FieldFrame
        label={label}
        required={required}
        controlId={id}
        control={<code id={id}>{formatJson(schema.const)}</code>}
        messages={messages}
      />
    );
  }

  if (schema.enum && schema.enum.length > 0) {
    const selected = schema.enum.findIndex((entry) => formatJson(entry) === formatJson(value));
    return (
      <FieldFrame
        label={label}
        required={required}
        controlId={id}
        control={(
          <select
            id={id}
            value={selected < 0 ? "" : String(selected)}
            disabled={disabled}
            required={required}
            aria-invalid={invalid}
            aria-describedby={ariaDescribedBy}
            onChange={(event) => {
              const index = Number(event.target.value);
              onChange(event.target.value === "" ? undefined : schema.enum![index]);
            }}
          >
            <option value="">Select…</option>
            {schema.enum.map((entry, index) => (
              <option key={`${formatJson(entry)}-${index}`} value={index}>
                {typeof entry === "string" ? entry : formatJson(entry)}
              </option>
            ))}
          </select>
        )}
        messages={messages}
      />
    );
  }

  const type = preferredType(schema, value);
  if (type === "object") {
    const object = objectValue(value);
    const requiredProperties = new Set(schema.required ?? []);
    return (
      <fieldset id={id} className="schema-object" aria-describedby={ariaDescribedBy}>
        <legend>
          {label}
          {required ? <span aria-label="required"> *</span> : null}
        </legend>
        {messages}
        {Object.entries(schema.properties ?? {}).map(([key, propertySchema]) => {
          const childPointer = appendJsonPointer(pointer, key);
          return (
            <SchemaField
              key={key}
              schema={propertySchema}
              value={object[key]}
              pointer={childPointer}
              label={propertySchema.title ?? key}
              required={requiredProperties.has(key)}
              issues={issues}
              idPrefix={idPrefix}
              disabled={disabled}
              onChange={(nextValue) => {
                const next = { ...object };
                if (nextValue === undefined) delete next[key];
                else next[key] = nextValue;
                onChange(next);
              }}
            />
          );
        })}
        {schema.additionalProperties !== false ? (
          <small>Additional properties can be edited in raw JSON mode.</small>
        ) : null}
      </fieldset>
    );
  }

  if (type === "array") {
    const items = Array.isArray(value) ? value : [];
    const itemSchema = schema.items ?? {};
    return (
      <fieldset id={id} className="schema-array" aria-describedby={ariaDescribedBy}>
        <legend>
          {label}
          {required ? <span aria-label="required"> *</span> : null}
        </legend>
        {messages}
        {items.map((item, index) => (
          <div className="schema-array-item" key={index}>
            <SchemaField
              schema={itemSchema}
              value={item}
              pointer={appendJsonPointer(pointer, index)}
              label={`Item ${index + 1}`}
              required
              issues={issues}
              idPrefix={idPrefix}
              disabled={disabled}
              onChange={(nextValue) => {
                const next = [...items];
                if (nextValue === undefined) next.splice(index, 1);
                else next[index] = nextValue;
                onChange(next);
              }}
            />
            <button
              type="button"
              disabled={disabled}
              aria-label={`Remove ${label} item ${index + 1}`}
              onClick={() => onChange(items.filter((_, itemIndex) => itemIndex !== index))}
            >
              Remove
            </button>
          </div>
        ))}
        <button
          type="button"
          disabled={disabled}
          onClick={() => onChange([...items, initialValueForSchema(itemSchema)])}
        >
          Add item
        </button>
      </fieldset>
    );
  }

  if (type === "boolean") {
    return (
      <FieldFrame
        label={label}
        required={required}
        controlId={id}
        control={(
          <div>
            <input
              id={id}
              type="checkbox"
              checked={value === true}
              disabled={disabled}
              required={required}
              aria-invalid={invalid}
              aria-describedby={ariaDescribedBy}
              onChange={(event) => onChange(event.target.checked)}
            />
            <span>{value === undefined ? "Not set" : value ? "True" : "False"}</span>
            {!required && value !== undefined ? (
              <button type="button" disabled={disabled} onClick={() => onChange(undefined)}>
                Clear
              </button>
            ) : null}
          </div>
        )}
        messages={messages}
      />
    );
  }

  if (type === "number" || type === "integer") {
    return (
      <FieldFrame
        label={label}
        required={required}
        controlId={id}
        control={(
          <input
            id={id}
            type="number"
            value={typeof value === "number" ? value : ""}
            min={schema.minimum}
            max={schema.maximum}
            step={type === "integer" ? 1 : "any"}
            disabled={disabled}
            required={required}
            aria-invalid={invalid}
            aria-describedby={ariaDescribedBy}
            onChange={(event) => {
              if (event.target.value === "") onChange(undefined);
              else onChange(Number(event.target.value));
            }}
          />
        )}
        messages={messages}
      />
    );
  }

  if (type === "null") {
    return (
      <FieldFrame
        label={label}
        required={required}
        controlId={id}
        control={(
          <select
            id={id}
            value={value === null ? "null" : ""}
            disabled={disabled}
            required={required}
            aria-invalid={invalid}
            aria-describedby={ariaDescribedBy}
            onChange={(event) => onChange(event.target.value === "null" ? null : undefined)}
          >
            <option value="">Not set</option>
            <option value="null">null</option>
          </select>
        )}
        messages={messages}
      />
    );
  }

  return (
    <FieldFrame
      label={label}
      required={required}
      controlId={id}
      control={(
        <input
          id={id}
          type="text"
          value={typeof value === "string" ? value : ""}
          minLength={schema.minLength}
          maxLength={schema.maxLength}
          disabled={disabled}
          required={required}
          aria-invalid={invalid}
          aria-describedby={ariaDescribedBy}
          onChange={(event) => onChange(event.target.value === "" && !required
            ? undefined
            : event.target.value)}
        />
      )}
      messages={messages}
    />
  );
}

export function SchemaForm({
  schema,
  value,
  onChange,
  issues = validateJsonSchema(schema, value),
  idPrefix = "schema-input",
  disabled = false,
}: SchemaFormProps) {
  return (
    <div className="schema-form">
      <SchemaField
        schema={schema}
        value={value}
        onChange={(nextValue) => onChange(nextValue ?? initialValueForSchema(schema))}
        pointer=""
        label={schema.title ?? "Arguments"}
        required
        issues={issues}
        idPrefix={idPrefix}
        disabled={disabled}
      />
    </div>
  );
}

export interface SynchronizedSchemaInputSnapshot {
  value: JsonValue;
  rawJson: string;
  parseError: string | null;
  issues: readonly SchemaValidationIssue[];
  isValid: boolean;
}

export interface SynchronizedSchemaInputController extends SynchronizedSchemaInputSnapshot {
  setFormValue: (value: JsonValue) => void;
  setRawJson: (rawJson: string) => void;
  reset: (value?: JsonValue) => void;
}

export function useSynchronizedSchemaInput(
  schema: JsonSchema,
  initialValue?: JsonValue,
): SynchronizedSchemaInputController {
  const firstValue = useMemo(
    () => initialValue ?? defaultsForSchema(schema) ?? initialValueForSchema(schema),
    [initialValue, schema],
  );
  const [value, setValue] = useState<JsonValue>(firstValue);
  const [rawJson, setRawJsonState] = useState(() => formatJson(firstValue));
  const [parseError, setParseError] = useState<string | null>(null);

  const setFormValue = useCallback((nextValue: JsonValue) => {
    setValue(nextValue);
    setRawJsonState(formatJson(nextValue));
    setParseError(null);
  }, []);

  const setRawJson = useCallback((nextRawJson: string) => {
    setRawJsonState(nextRawJson);
    const parsed = parseJsonValue(nextRawJson);
    if (parsed.ok) {
      setValue(parsed.value);
      setParseError(null);
    } else {
      setParseError(parsed.error);
    }
  }, []);

  const reset = useCallback((nextValue?: JsonValue) => {
    setFormValue(nextValue ?? defaultsForSchema(schema) ?? initialValueForSchema(schema));
  }, [schema, setFormValue]);

  const issues = useMemo(() => validateJsonSchema(schema, value), [schema, value]);
  return {
    value,
    rawJson,
    parseError,
    issues,
    isValid: parseError === null && issues.length === 0,
    setFormValue,
    setRawJson,
    reset,
  };
}

export interface SynchronizedSchemaFormProps {
  schema: JsonSchema;
  initialValue?: JsonValue;
  onChange?: (snapshot: SynchronizedSchemaInputSnapshot) => void;
  idPrefix?: string;
  disabled?: boolean;
  defaultMode?: "form" | "raw";
  mode?: "form" | "raw";
  onModeChange?: (mode: "form" | "raw") => void;
}

export function SynchronizedSchemaForm({
  schema,
  initialValue,
  onChange,
  idPrefix = "schema-input",
  disabled = false,
  defaultMode = "form",
  mode: controlledMode,
  onModeChange,
}: SynchronizedSchemaFormProps) {
  const controller = useSynchronizedSchemaInput(schema, initialValue);
  const [internalMode, setInternalMode] = useState<"form" | "raw">(defaultMode);
  const mode = controlledMode ?? internalMode;
  const selectMode = (nextMode: "form" | "raw") => {
    if (controlledMode === undefined) setInternalMode(nextMode);
    onModeChange?.(nextMode);
  };
  const snapshot = useMemo<SynchronizedSchemaInputSnapshot>(() => ({
    value: controller.value,
    rawJson: controller.rawJson,
    parseError: controller.parseError,
    issues: controller.issues,
    isValid: controller.isValid,
  }), [controller.value, controller.rawJson, controller.parseError, controller.issues, controller.isValid]);

  useEffect(() => onChange?.(snapshot), [onChange, snapshot]);

  const formTabId = `${idPrefix}-form-tab`;
  const rawTabId = `${idPrefix}-raw-tab`;
  const panelId = `${idPrefix}-${mode}-panel`;
  const rawErrorId = `${idPrefix}-raw-error`;
  const rawValidationId = `${idPrefix}-raw-validation`;

  return (
    <section className="synchronized-schema-form" aria-label={schema.title ?? "Tool input"}>
      <div role="tablist" aria-label="Input mode">
        <button
          id={formTabId}
          type="button"
          role="tab"
          aria-selected={mode === "form"}
          aria-controls={mode === "form" ? panelId : undefined}
          onClick={() => selectMode("form")}
        >
          Form
        </button>
        <button
          id={rawTabId}
          type="button"
          role="tab"
          aria-selected={mode === "raw"}
          aria-controls={mode === "raw" ? panelId : undefined}
          onClick={() => selectMode("raw")}
        >
          Raw JSON
        </button>
      </div>

      {mode === "form" ? (
        <div id={panelId} role="tabpanel" aria-labelledby={formTabId}>
          <SchemaForm
            schema={schema}
            value={controller.value}
            onChange={controller.setFormValue}
            issues={controller.issues}
            idPrefix={idPrefix}
            disabled={disabled}
          />
        </div>
      ) : (
        <div id={panelId} role="tabpanel" aria-labelledby={rawTabId}>
          <label htmlFor={`${idPrefix}-raw-input`}>Raw JSON</label>
          <textarea
            id={`${idPrefix}-raw-input`}
            value={controller.rawJson}
            disabled={disabled}
            spellCheck={false}
            rows={12}
            aria-invalid={controller.parseError !== null || controller.issues.length > 0}
            aria-describedby={controller.parseError
              ? rawErrorId
              : controller.issues.length > 0
                ? rawValidationId
                : undefined}
            onChange={(event) => controller.setRawJson(event.target.value)}
          />
          {controller.parseError ? (
            <p id={rawErrorId} role="alert">{controller.parseError}</p>
          ) : controller.issues.length > 0 ? (
            <ul id={rawValidationId} aria-live="polite">
              {controller.issues.map((entry, index) => (
                <li key={`${entry.pointer}-${entry.keyword}-${index}`}>
                  {entry.pointer || "/"}: {entry.message}
                </li>
              ))}
            </ul>
          ) : null}
        </div>
      )}
    </section>
  );
}
