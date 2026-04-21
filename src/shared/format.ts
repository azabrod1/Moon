export function formatScaleMultiplier(value: number): string {
  return Number.isInteger(value) ? `${value}×` : `${value.toFixed(1)}×`;
}
