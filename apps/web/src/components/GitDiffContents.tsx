import { type CSSProperties, useMemo } from "react";
import { parsePatchFiles } from "@pierre/diffs";
import { FileDiff } from "@pierre/diffs/react";

type GitDiffContentsProps = {
  appearance: "light" | "dark" | "system";
  split: boolean;
  wrap: boolean;
  diff: {
    path: string;
    staged: boolean;
    patch: string;
    binary: boolean;
    error: string | null;
  };
};

export default function GitDiffContents({ diff, appearance, split, wrap }: GitDiffContentsProps) {
  const fileDiff = useMemo(() => {
    if (!diff.patch || diff.binary) return null;
    try {
      return parsePatchFiles(
        diff.patch,
        `${diff.staged ? "staged" : "working"}:${diff.path}`,
        true,
      )[0]?.files[0] ?? null;
    } catch {
      return null;
    }
  }, [diff.patch, diff.path, diff.staged, diff.binary]);

  if (diff.error) {
    return <p className="p-4 text-sm leading-6 text-destructive">{diff.error}</p>;
  }
  if (diff.binary) {
    return <p className="p-4 text-sm leading-6 text-muted-foreground">Binary files cannot be shown as a text diff.</p>;
  }
  if (!diff.patch.trim()) {
    return <p className="p-4 text-sm leading-6 text-muted-foreground">There are no textual changes to show.</p>;
  }
  if (!fileDiff || !fileDiff.hunks.length) {
    return (
      <pre className={`${wrap ? "whitespace-pre-wrap break-words" : "min-w-max whitespace-pre"} p-4 text-xs leading-5 text-muted-foreground`}>
        {diff.patch}
      </pre>
    );
  }
  return (
    <FileDiff
      className="min-w-full"
      disableWorkerPool
      fileDiff={fileDiff}
      options={{
        diffIndicators: "bars",
        diffStyle: split ? "split" : "unified",
        disableFileHeader: true,
        hunkSeparators: "line-info",
        overflow: wrap ? "wrap" : "scroll",
        themeType: appearance,
      }}
      style={{
        "--diffs-font-family": '"JetBrains Mono Variable", monospace',
        "--diffs-header-font-family": '"Inter Variable", sans-serif',
      } as CSSProperties}
    />
  );
}
