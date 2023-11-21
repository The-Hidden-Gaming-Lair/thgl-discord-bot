import { BodyInit, ResponseInit } from "undici-types";

const RESPONSE_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "OPTIONS, GET",
  "Access-Control-Allow-Headers": "Content-Type",
  "Cache-Control": "public, max-age=60, s-maxage=60",
};

export class ClientResponse extends Response {
  constructor(body?: BodyInit, init?: ResponseInit) {
    super(body, init);
    Object.entries(RESPONSE_HEADERS).forEach(([key, value]) => {
      this.headers.set(key, value);
    });
  }

  static json(data: any, init: ResponseInit = {}): Response {
    Object.assign(init, { headers: RESPONSE_HEADERS });
    return super.json(data, init);
  }
}
