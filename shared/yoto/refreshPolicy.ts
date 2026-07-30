export function shouldPreserveAuxiliaryRefreshState(
  auxiliary: boolean,
  wasConnected: boolean,
  statusCode?: number,
): boolean {
  const transientFailure = statusCode === undefined
    || statusCode === 408
    || statusCode === 429
    || statusCode >= 500

  return auxiliary && wasConnected && transientFailure
}
