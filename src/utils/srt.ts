import type {
  ActionAnnotation,
  CharacterAnnotation,
  SubtitleLine,
} from "../types";

const SRT_TIME_PATTERN =
  /(?<start>\d{2}:\d{2}:\d{2},\d{3})\s*-->\s*(?<end>\d{2}:\d{2}:\d{2},\d{3})/;

export function parseSrtTime(time: string): number {
  const [hh, mm, rest] = time.trim().split(":");
  const [ss, ms] = rest.split(",");
  return (
    Number(hh) * 3600 +
    Number(mm) * 60 +
    Number(ss) +
    Number(ms) / 1000
  );
}

export function formatSecondsToSrtTime(seconds: number): string {
  const totalMilliseconds = Math.max(0, Math.round(seconds * 1000));
  const hours = Math.floor(totalMilliseconds / 3_600_000);
  const minutes = Math.floor((totalMilliseconds % 3_600_000) / 60_000);
  const secs = Math.floor((totalMilliseconds % 60_000) / 1000);
  const millis = totalMilliseconds % 1000;
  return [hours, minutes, secs]
    .map((part) => String(part).padStart(2, "0"))
    .join(":")
    .concat(",", String(millis).padStart(3, "0"));
}

export function parseSrt(text: string): SubtitleLine[] {
  return text
    .trim()
    .split(/\r?\n\r?\n/)
    .map((block, index) => {
      const lines = block.split(/\r?\n/).map((line) => line.trim());
      const timeLine = lines.find((line) => SRT_TIME_PATTERN.test(line));
      if (!timeLine) {
        return null;
      }
      const match = timeLine.match(SRT_TIME_PATTERN);
      if (!match?.groups) {
        return null;
      }
      const contentStart = lines.findIndex((line) => line === timeLine) + 1;
      const textContent = lines.slice(contentStart).join("");
      return {
        id: `line-${index + 1}`,
        text: textContent,
        startTime: parseSrtTime(match.groups.start),
        endTime: parseSrtTime(match.groups.end),
      } satisfies SubtitleLine;
    })
    .filter((item): item is SubtitleLine => Boolean(item));
}

function buildSrtBlock(index: number, startTime: number, endTime: number, text: string) {
  return `${index}\n${formatSecondsToSrtTime(startTime)} --> ${formatSecondsToSrtTime(
    endTime,
  )}\n${text}`;
}

export function exportCharacterTrackToSrt(
  annotations: CharacterAnnotation[],
): string {
  return annotations
    .slice()
    .sort((a, b) => a.startTime - b.startTime)
    .map((annotation, index) =>
      buildSrtBlock(index + 1, annotation.startTime, annotation.endTime, annotation.char),
    )
    .join("\n\n");
}

export function exportSingingStyleTrackToSrt(
  annotations: CharacterAnnotation[],
): string {
  return annotations
    .slice()
    .sort((a, b) => a.startTime - b.startTime)
    .map((annotation, index) =>
      buildSrtBlock(
        index + 1,
        annotation.startTime,
        annotation.endTime,
        `${annotation.char} | ${annotation.singingStyle}`,
      ),
    )
    .join("\n\n");
}

export function exportActionTrackToSrt(
  annotations: ActionAnnotation[],
  trackId: string,
): string {
  return annotations
    .filter((annotation) => annotation.trackId === trackId)
    .slice()
    .sort((a, b) => a.startTime - b.startTime)
    .map((annotation, index) =>
      buildSrtBlock(index + 1, annotation.startTime, annotation.endTime, annotation.label),
    )
    .join("\n\n");
}
