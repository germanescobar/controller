export const MOBILE_COMPOSER_MEDIA_QUERY = "(max-width: 767px)";

export interface ComposerLayout {
  showDetails: boolean;
  showCompactActions: boolean;
  maxLines: number;
  autoFocusOnSessionChange: boolean;
}

/**
 * Desktop keeps the existing composer at all times. On mobile the idle
 * composer is a single real textarea and expands only while focus is within
 * the composer.
 */
export function getComposerLayout(
  isMobileViewport: boolean,
  hasFocus: boolean,
  expandedMaxLines: number,
): ComposerLayout {
  const showDetails = !isMobileViewport || hasFocus;
  return {
    showDetails,
    showCompactActions: isMobileViewport && !hasFocus,
    maxLines: showDetails ? expandedMaxLines : 1,
    autoFocusOnSessionChange: !isMobileViewport,
  };
}
