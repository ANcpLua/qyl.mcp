import type {
  AudioContent,
  CallToolResult,
  ContentBlock,
  EmbeddedResource,
  ImageContent,
  ResourceLink,
  TextContent,
} from "@modelcontextprotocol/sdk/types.js";
import { JsonCodeView } from "./JsonCodeView.js";
import {
  estimatedBase64Bytes,
  safeExternalHref,
  safeImageDataUrl,
} from "./content-safety.js";

export interface ContentRendererProps {
  result: CallToolResult;
  className?: string;
  onCopyStructuredContent?: (formattedJson: string) => void | Promise<void>;
}

function formatBytes(bytes: number | undefined): string {
  if (bytes === undefined) return "unknown size";
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KiB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MiB`;
}

function TextBlock({ content }: { content: TextContent }) {
  return (
    <section className="content-block content-text" aria-label="Text content">
      <pre><code>{content.text}</code></pre>
    </section>
  );
}

function ImageBlock({ content }: { content: ImageContent }) {
  const source = safeImageDataUrl(content);
  if (!source) {
    return (
      <section className="content-block content-unsupported" role="status">
        Image blocked: unsupported MIME type or invalid base64 data ({content.mimeType}).
      </section>
    );
  }
  return (
    <figure className="content-block content-image">
      <img
        src={source}
        alt={`Tool result image (${content.mimeType})`}
        loading="lazy"
        decoding="async"
      />
      <figcaption>{content.mimeType} · {formatBytes(estimatedBase64Bytes(content.data))}</figcaption>
    </figure>
  );
}

function AudioBlock({ content }: { content: AudioContent }) {
  return (
    <section className="content-block content-audio" aria-label="Audio content">
      <strong>Audio attachment</strong>
      <span>{content.mimeType} · {formatBytes(estimatedBase64Bytes(content.data))}</span>
      <small>Playback is disabled; binary tool output is not executed or embedded.</small>
    </section>
  );
}

function EmbeddedResourceBlock({ content }: { content: EmbeddedResource }) {
  const resource = content.resource;
  return (
    <section className="content-block content-resource" aria-label="Embedded resource">
      <header>
        <strong>Embedded resource</strong>
        <code>{resource.uri}</code>
        {resource.mimeType ? <span>{resource.mimeType}</span> : null}
      </header>
      {"text" in resource ? (
        <pre><code>{resource.text}</code></pre>
      ) : (
        <p>Binary resource · {formatBytes(estimatedBase64Bytes(resource.blob))}</p>
      )}
    </section>
  );
}

function ResourceLinkBlock({ content }: { content: ResourceLink }) {
  const href = safeExternalHref(content.uri);
  return (
    <section className="content-block content-resource-link" aria-label="Resource link">
      <strong>{content.title ?? content.name}</strong>
      {content.description ? <p>{content.description}</p> : null}
      {href ? (
        <a href={href} target="_blank" rel="noopener noreferrer">
          {content.uri}
        </a>
      ) : (
        <span data-link-blocked="true">
          Blocked link: <code>{content.uri}</code>
        </span>
      )}
    </section>
  );
}

function renderContentBlock(content: ContentBlock, index: number) {
  switch (content.type) {
    case "text":
      return <TextBlock key={index} content={content} />;
    case "image":
      return <ImageBlock key={index} content={content} />;
    case "audio":
      return <AudioBlock key={index} content={content} />;
    case "resource":
      return <EmbeddedResourceBlock key={index} content={content} />;
    case "resource_link":
      return <ResourceLinkBlock key={index} content={content} />;
  }
}

/** Renders MCP result data through fixed components; it never interprets HTML. */
export function ContentRenderer({
  result,
  className,
  onCopyStructuredContent,
}: ContentRendererProps) {
  return (
    <section
      className={className ?? "content-renderer"}
      aria-label="Tool result"
      data-error={result.isError === true ? "true" : "false"}
    >
      {result.isError ? <p role="alert">The tool reported an error.</p> : null}
      <div className="content-blocks">
        {result.content.map(renderContentBlock)}
      </div>
      {result.structuredContent !== undefined ? (
        <JsonCodeView
          value={result.structuredContent}
          label="Structured content"
          onCopy={onCopyStructuredContent}
        />
      ) : null}
    </section>
  );
}
