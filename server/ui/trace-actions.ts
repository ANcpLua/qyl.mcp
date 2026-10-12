import type { Annotation, CompareTracesOutput, Trace } from "@ancplua/qyl-api-schema/types";
import type { CallToolResult } from "@modelcontextprotocol/server";
import { contractSchema } from "../src/contract-validation.ts";
import { toolErrorText } from "./mcp-app-client.ts";

type CallTool = (request: { name: string; arguments: Record<string, unknown> }) => Promise<CallToolResult>;

/** Comparison pairs come from the same alignment used by the text tool. */
export function renderComparison(container: HTMLElement, result?: CompareTracesOutput): void {
  container.replaceChildren();
  container.hidden = result === undefined;
  if (!result) return;
  const heading = document.createElement("h3");
  heading.textContent = result.comparable ? "Execution comparison" : result.reason ?? "Executions are not comparable";
  container.appendChild(heading);
  const divergence = result.first_divergence;
  if (divergence) {
    const explanation = document.createElement("p");
    explanation.textContent = `First divergence: ${divergence.kind}${divergence.attribute ? ` (${divergence.attribute})` : ""}`;
    container.appendChild(explanation);
  }
  for (const pair of result.aligned) {
    const row = document.createElement("div");
    row.className = "comparison-pair";
    if (pair.a_span.span_id === divergence?.a_span?.span_id || pair.b_span.span_id === divergence?.b_span?.span_id) {
      row.classList.add("first-divergence");
    }
    for (const [label, span] of [["A", pair.a_span], ["B", pair.b_span]] as const) {
      const card = document.createElement("div");
      card.className = "comparison-span";
      card.textContent = `${label}: ${span.service} / ${span.name} · ${span.status} · ${span.duration_ms} ms`;
      row.appendChild(card);
    }
    container.appendChild(row);
  }
  for (const span of result.unmatched) {
    const row = document.createElement("p");
    row.textContent = `Unmatched: ${span.service} / ${span.name} · ${span.status} · ${span.duration_ms} ms`;
    container.appendChild(row);
  }
}

/** Write calls are reachable only from explicit note/bookmark controls. */
export function traceActions(trace: Trace, selectedSpan: () => string | undefined, call: CallTool): HTMLElement {
  const section = document.createElement("section");
  section.className = "trace-actions";
  const notes = document.createElement("button");
  notes.type = "button";
  notes.textContent = "Notes";
  const bookmark = document.createElement("button");
  bookmark.type = "button";
  bookmark.textContent = "Bookmark";
  const editor = document.createElement("div");
  editor.className = "annotation-editor";
  editor.hidden = true;
  const status = document.createElement("p");
  status.setAttribute("role", "status");
  const target = () => selectedSpan()
    ? { kind: "span", trace_id: trace.trace_id, span_id: selectedSpan() }
    : { kind: "trace", trace_id: trace.trace_id };
  async function send(name: string, args: Record<string, unknown>): Promise<Annotation> {
    const result = await call({ name, arguments: args });
    if (result.isError) throw new Error(toolErrorText(result) ?? "Unable to save annotation");
    const annotation = contractSchema("Mcp.Tools.AnnotationOutput").parse(result.structuredContent).annotation;
    if (!annotation) throw new Error("Collector did not return the saved annotation");
    return annotation;
  }
  function form(annotation?: Annotation) {
    const element = document.createElement("form");
    const text = document.createElement("textarea");
    text.maxLength = 2000;
    text.required = true;
    text.setAttribute("aria-label", "Annotation text");
    text.value = annotation?.text ?? "";
    const labels = document.createElement("input");
    labels.setAttribute("aria-label", "Labels separated by commas");
    labels.placeholder = "Labels, separated by commas";
    labels.value = annotation?.labels?.join(", ") ?? "";
    const classification = document.createElement("select");
    classification.setAttribute("aria-label", "Annotation classification");
    for (const value of ["note", "hypothesis", "finding", "rejected"]) {
      const option = document.createElement("option");
      option.value = value; option.textContent = value;
      classification.appendChild(option);
    }
    classification.value = annotation?.classification ?? "note";
    const save = document.createElement("button");
    save.type = "submit"; save.textContent = annotation ? "Update note" : "Add note";
    element.append(text, labels, classification, save);
    const idempotencyKey = crypto.randomUUID();
    element.addEventListener("submit", (event) => {
      void (async () => {
      event.preventDefault(); save.disabled = true;
      try {
        const changes = { text: text.value, labels: labels.value.split(",").map((v) => v.trim()).filter(Boolean), classification: classification.value };
        if (changes.labels.length > 10 || changes.labels.some((v) => v.length > 64)) throw new Error("Use at most 10 labels of at most 64 characters.");
        const stored = annotation
          ? await send("update_annotation", { id: annotation.id, etag: annotation.etag, ...changes })
          : await send("create_annotation", { target: target(), idempotency_key: idempotencyKey, ...changes });
        status.textContent = "Note saved.";
        element.replaceWith(form(stored));
      } catch (error) { status.textContent = error instanceof Error ? error.message : String(error); }
      finally { save.disabled = false; }
      })();
    });
    return element;
  }
  notes.addEventListener("click", () => {
    void (async () => {
    editor.hidden = !editor.hidden;
    if (editor.hidden) return;
    if (editor.childElementCount > 0) return;
    editor.replaceChildren(form());
    try {
      const result = await call({ name: "get_trace", arguments: { trace_id: trace.trace_id, max_spans: 1 } });
      if (result.isError) throw new Error(toolErrorText(result) ?? "Unable to read notes");
      const output = contractSchema("Mcp.Tools.GetTraceOutput").parse(result.structuredContent);
      for (const annotation of output.annotations ?? []) editor.appendChild(form(annotation));
    } catch (error) { status.textContent = error instanceof Error ? error.message : String(error); }
    })();
  });
  bookmark.addEventListener("click", () => {
    void (async () => {
    bookmark.disabled = true;
    try {
      await send("create_annotation", { target: target(), text: "Bookmarked execution", labels: ["bookmark"], classification: "note" });
      status.textContent = "Bookmark saved.";
    } catch (error) { status.textContent = error instanceof Error ? error.message : String(error); }
    finally { bookmark.disabled = false; }
    })();
  });
  section.append(notes, bookmark, status, editor);
  return section;
}
