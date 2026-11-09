import type { Finish, Language } from "../decks/types";
import type { Candidate } from "./match";

export type PriceStatus =
  | "ok"
  | "not_found" // 検索結果なし
  | "multiple_candidates" // 複数候補
  | "access_error" // アクセスエラー
  | "parse_error" // 解析失敗
  | "not_listed" // 価格非公開・掲載なし
  | "pending_review"; // 照合の確認待ち

export const STATUS_LABEL: Record<PriceStatus, string> = {
  ok: "取得成功",
  not_found: "検索結果なし",
  multiple_candidates: "複数候補",
  access_error: "アクセスエラー",
  parse_error: "解析失敗",
  not_listed: "価格非公開",
  pending_review: "照合確認待ち",
};

export interface PrintingForLookup {
  printingId: string;
  name: string;
  setCode: string;
  collectorNumber: string;
  language: Language;
  finish: Finish;
  knownExternalId?: string | null;
  knownUrl?: string | null;
}

export interface LookupResult {
  status: PriceStatus;
  priceJpy?: number | null;
  candidate?: Candidate;
  candidates?: Candidate[];
  matchStatus?: "auto_exact" | "auto_unique";
  detail?: string;
}

/**
 * 価格取得アダプター。取得元（買取サイト）ごとに実装を差し替えます。
 * 自動取得できない取得元は実装せず、CSV取込・手入力（method = csv / manual）で記録します。
 */
export interface PriceAdapter {
  readonly sourceId: string;
  lookup(p: PrintingForLookup): Promise<LookupResult>;
}

/** 一時的な失敗（再試行の対象） */
export const RETRYABLE: PriceStatus[] = ["access_error"];
