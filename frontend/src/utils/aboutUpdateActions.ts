export type AboutUpdateActionsSurface = 'settings-center' | 'legacy-modal';

export const shouldShowFooterReleaseNotesAction = (
  surface: AboutUpdateActionsSurface,
): boolean => surface === 'legacy-modal';
