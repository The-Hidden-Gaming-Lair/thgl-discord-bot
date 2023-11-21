import { BodyInit, ResponseInit } from "undici-types";

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "OPTIONS, GET",
  "Access-Control-Allow-Headers": "Content-Type",
};

export class ClientResponse extends Response {
  constructor(body?: BodyInit, init?: ResponseInit) {
    super(body, init);
    Object.entries(CORS_HEADERS).forEach(([key, value]) => {
      this.headers.set(key, value);
    });
  }

  static json(data: any, init: ResponseInit = {}): Response {
    Object.assign(init, { headers: CORS_HEADERS });
    return super.json(data, init);
  }
}
