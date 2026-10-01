export type SerpItem = {
  extensionId: string;
  position: number;
  title?: string;
};

export type PageClassification =
  | "normal"
  | "rate-limited"
  | "consent"
  | "captcha"
  | "http-error"
  | "unexpected";

export type ProbeResult = {
  requestedAt: string;
  keyword: string;
  locale: string;
  url: string;
  status: number;
  bytes: number;
  elapsedMs: number;
  pageClassification: PageClassification;
  stopRecommended: boolean;
  containsEditPage: boolean;
  rawIds: string[];
  rawIdCount: number;
  parsedSerp: SerpItem[] | null;
  parser: {
    reliable: boolean;
    strategy: string | null;
    diagnostics: string[];
  };
  editPageRank: number | null;
  requestedTopN: number;
  collectedCount: number;
  loadedBatches: number;
  collectionMode: "http-pagination" | "browser-load-more";
  complete: boolean;
  notFoundWithin: number | null;
  endOfResults: boolean;
  artifacts: {
    html: string;
    json: string;
    screenshot?: string;
    pagination?: string;
  };
};
