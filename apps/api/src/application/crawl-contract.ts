export class CrawlError extends Error {
  constructor(
    readonly code: string,
    readonly retryable = false,
  ) {
    super(code);
  }
}
export interface HttpDocument {
  url: string;
  text: string;
  contentType: string;
}
export type HttpPermission = (url: string, signal?: AbortSignal) => Promise<void>;
export interface HttpReader {
  get(
    url: string,
    allowed?: HttpPermission,
    signal?: AbortSignal,
  ): Promise<HttpDocument>;
}
