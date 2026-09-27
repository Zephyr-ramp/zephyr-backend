/** An error that maps to a SEP-style `{ "error": "..." }` HTTP response. */
export class AnchorError extends Error {
  constructor(
    public readonly statusCode: number,
    message: string,
    public readonly body?: Record<string, unknown>,
  ) {
    super(message);
    this.name = "AnchorError";
  }
}
