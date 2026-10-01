import type { SerpItem } from "../types.js";

export type CollectionResult = {
  status: number;
  html: string;
  items: SerpItem[] | null;
  reliable: boolean;
  strategy: string | null;
  diagnostics: string[];
  loadedBatches: number;
  endOfResults: boolean;
  screenshot?: Uint8Array;
  paginationResponses?: string[];
};
