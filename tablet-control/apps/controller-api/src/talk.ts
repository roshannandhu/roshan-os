import { ApiProblem } from "./errors.js";

export interface TalkLease {
  sessionId: string;
  startedAt: number;
}

export class TalkCoordinator {
  private activeLease: TalkLease | undefined;

  public start(sessionId: string): TalkLease {
    if (this.activeLease !== undefined && this.activeLease.sessionId !== sessionId) {
      throw new ApiProblem(409, "CONFLICT", "Another talk transmission is already active.", true);
    }

    if (this.activeLease === undefined) {
      this.activeLease = {
        sessionId,
        startedAt: Date.now()
      };
    }

    return this.activeLease;
  }

  public stop(sessionId: string): boolean {
    if (this.activeLease?.sessionId !== sessionId) {
      return false;
    }

    this.activeLease = undefined;
    return true;
  }

  public isActiveFor(sessionId: string): boolean {
    return this.activeLease?.sessionId === sessionId;
  }
}
