import { useEffect, useState } from "react";
import { ArrowDown, Check, Copy } from "lucide-react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { Button, Separator } from "@/components/ui";

export function GitFlowSeparator() {
  return (
    <div aria-hidden="true" className="flex items-center gap-2 py-0.5 text-muted-foreground/60">
      <Separator className="flex-1" />
      <ArrowDown className="size-3" />
      <Separator className="flex-1" />
    </div>
  );
}

export function AssistantMarkdown({ content }: { content: string }) {
  return (
    <div className="markdown">
      <ReactMarkdown remarkPlugins={[remarkGfm]}>{content}</ReactMarkdown>
    </div>
  );
}

export function CopyButton({ content, className, label = "Copy message" }: { content: string; className: string; label?: string }) {
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    if (!copied) return;
    const timeout = window.setTimeout(() => setCopied(false), 1500);
    return () => window.clearTimeout(timeout);
  }, [copied]);

  return (
    <Button
      aria-label={copied ? "Copied" : label}
      className={`size-7 text-muted-foreground opacity-60 hover:opacity-100 ${className}`}
      size="icon-sm"
      data-tooltip={copied ? "Copied" : label}
      type="button"
      variant="ghost"
      onClick={() => navigator.clipboard.writeText(content).then(() => setCopied(true)).catch(() => undefined)}
    >
      {copied ? <Check aria-hidden="true" className="size-3.5" /> : <Copy aria-hidden="true" className="size-3.5" />}
    </Button>
  );
}

export function ShortcutKeys({ keys }: { keys: string[] }) {
  return (
    <span className="flex items-center gap-1">
      {keys.map((key) => (
        <kbd className="min-w-7 rounded border bg-muted px-2 py-1 text-center font-mono text-xs" key={key}>
          {key}
        </kbd>
      ))}
    </span>
  );
}
