import { nameKey, type Finish, type Language } from "../decks/types";

export interface PrintingTarget {
  name: string;
  setCode: string;
  collectorNumber: string;
  language: Language;
  finish: Finish;
}

export interface Candidate {
  externalId?: string | null;
  url?: string | null;
  name: string;
  setCode?: string | null;
  collectorNumber?: string | null;
  language?: Language | null;
  finish?: Finish | null;
  priceJpy?: number | null;
}

export type MatchOutcome =
  | { kind: "matched"; matchStatus: "auto_exact" | "auto_unique"; candidate: Candidate }
  | { kind: "multiple"; candidates: Candidate[] }
  | { kind: "none"; reason: string };

const normNum = (n?: string | null) => (n ?? "").trim().replace(/^0+(?=\d)/, "").toLowerCase();

/**
 * 価格検索結果とカード版の照合。誤った別版の価格を採用しないことを最優先にします。
 *  1. セット・番号・言語・仕様が完全一致 → 採用（auto_exact）
 *  2. 番号以外（名前・セット・言語・仕様）が一致し、番号が載っていない候補が一意 → 採用（auto_unique）
 *  3. 候補が複数 → 手動確認
 *  4. 該当なし → 取得失敗
 * 名前だけ一致（セットや仕様が不明・不一致）の候補は採用しません。
 */
export function matchCandidates(t: PrintingTarget, cands: Candidate[]): MatchOutcome {
  const sameCard = cands.filter((c) => nameKey(c.name) === nameKey(t.name));
  const sameSpec = sameCard.filter(
    (c) => c.setCode?.toUpperCase() === t.setCode.toUpperCase() && c.language === t.language && c.finish === t.finish,
  );
  const exact = sameSpec.filter((c) => c.collectorNumber && normNum(c.collectorNumber) === normNum(t.collectorNumber));
  if (exact.length === 1) return { kind: "matched", matchStatus: "auto_exact", candidate: exact[0] };
  if (exact.length > 1) return { kind: "multiple", candidates: exact };

  // 番号が別の値として載っている候補は別版なので除外。番号が載っていない候補だけを対象にする
  const noNumber = sameSpec.filter((c) => !c.collectorNumber);
  if (noNumber.length === 1) return { kind: "matched", matchStatus: "auto_unique", candidate: noNumber[0] };
  if (noNumber.length > 1) return { kind: "multiple", candidates: noNumber };

  if (!sameCard.length) return { kind: "none", reason: "同名のカードが検索結果にありません" };
  if (!sameSpec.length) return { kind: "none", reason: "同名カードはあるが、セット・言語・仕様が一致しません" };
  return { kind: "none", reason: "同じセットの別番号（別版）しか見つかりません" };
}
