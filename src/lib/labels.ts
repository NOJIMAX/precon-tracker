export const JOB_STATUS_LABEL: Record<string, string> = {
  running: "実行中",
  succeeded: "成功",
  partial: "一部失敗",
  failed: "失敗",
};

export const JOB_KIND_LABEL: Record<string, string> = {
  daily: "定期更新",
  manual: "手動更新",
  import: "CSV取込",
  deck_check: "リスト確認",
};

export const SECTION_LABEL: Record<string, string> = {
  commander: "統率者",
  main: "メイン",
  token: "トークン",
  display: "ディスプレイ",
  other: "その他",
};

export const FINISH_LABEL: Record<string, string> = { nonfoil: "通常", foil: "Foil", etched: "エッチング" };
