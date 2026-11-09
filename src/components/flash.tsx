import { Notice } from "./ui";

export function Flash({ msg, err }: { msg?: string; err?: string }) {
  if (!msg && !err) return null;
  return <div className="mb-4">{err ? <Notice tone="red">{err}</Notice> : <Notice tone="green">{msg}</Notice>}</div>;
}
