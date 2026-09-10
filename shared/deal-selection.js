export const DEAL_BIAS_MODES = Object.freeze(['off','light','strong']);
export function dealSelectionError() {
  return Object.assign(new Error('Deal selection provenance is unavailable'),{code:'DEAL_SELECTION_INVALID'});
}
export function projectDealSelection(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || Object.keys(value).sort().join(',') !== 'algorithmVersion,mode,schemaVersion'
    || value.schemaVersion !== 1 || value.algorithmVersion !== 'weighted-holes-v1'
    || !DEAL_BIAS_MODES.includes(value.mode)) throw dealSelectionError();
  return {schemaVersion:1,algorithmVersion:'weighted-holes-v1',mode:value.mode};
}
export function dealSelectionFields(row) {
  if (row?.dealSelection === undefined && row?.dealSelectionContractVersion == null) {
    if (row?.schemaVersion >= 7) throw dealSelectionError();
    return {};
  }
  if (row.dealSelectionContractVersion !== 1) throw dealSelectionError();
  return {dealSelectionContractVersion:1,dealSelection:projectDealSelection(row.dealSelection)};
}
export function dealSelectionDisposition(row) {
  try { return dealSelectionFields(row).dealSelection?.mode === undefined
    || row.dealSelection.mode === 'off' ? 'independent' : 'biased'; }
  catch { return 'unavailable'; }
}
export function checkDealBiasResume(config, requested) {
  const stored=config?.dealBias ?? 'off';
  if (!DEAL_BIAS_MODES.includes(stored) || (config?.dealSelectionContractVersion != null && config.dealSelectionContractVersion !== 1)
    || (config?.dealSelectionContractVersion === 1 && config.dealBias === undefined)
    || (stored !== 'off' && config?.dealSelectionContractVersion !== 1)
    || (requested !== undefined && requested !== stored)) throw dealSelectionError();
  return stored;
}
