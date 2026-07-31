import { type ApiFailure, type ErrorCode, failure } from "@tablet-control/shared-types";

export class ApiProblem extends Error {
  public readonly response: ApiFailure;

  public constructor(
    public readonly statusCode: number,
    code: ErrorCode,
    message: string,
    recoverable: boolean
  ) {
    super(message);
    this.name = "ApiProblem";
    this.response = failure(code, message, recoverable);
  }
}
