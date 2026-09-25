export class HttpError extends Error {
  statusCode: number;

  constructor(message: string, statusCode: number) {
    super(message);
    this.name = 'HttpError';
    this.statusCode = statusCode;
  }
}

export function httpError(message: string, statusCode: number): HttpError {
  return new HttpError(message, statusCode);
}

export function notFound(message: string): HttpError {
  return httpError(message, 404);
}
