"use client";
import { useFormStatus } from "react-dom";
import { btn, btnPrimary } from "./ui";

/** 送信中は押せなくし、二重送信を防ぐボタン */
export function Submit({ children, primary, pendingText, className }: { children: React.ReactNode; primary?: boolean; pendingText?: string; className?: string }) {
  const { pending } = useFormStatus();
  return (
    <button type="submit" disabled={pending} className={`${primary ? btnPrimary : btn} ${className ?? ""}`}>
      {pending ? pendingText ?? "処理中…" : children}
    </button>
  );
}
