import { useEffect, useMemo, useState } from "react";
import { productApiClient, type ReviewsResponse } from "../api/productApi";
import type { ProductState } from "../domain/types";
import type { View } from "../ui";

/** Views that surface monthly/yearly review or radar — only these trigger LLM reviews fetch. */
const REVIEWS_VIEWS = new Set<View>(["themes", "track", "home"]);
const DEBOUNCE_MS = 2000;

export interface UseServerReviewsArgs {
  apiPersistenceEnabled: boolean;
  view: View;
  productState: ProductState;
  /** Manual retry (ThemesView retry button); bumps force an immediate fetch. */
  reviewsNonce: number;
}

/**
 * B6: view-gated + debounced GET /api/reviews (SWR).
 * - Only when API online and view ∈ {themes, track, home}
 * - Asset signature debounced 2s (not bare revision on every autosave)
 * - reviewsNonce forces refresh immediately
 * - On error: set reviewsError, keep previous serverReviews
 */
export function useServerReviews({
  apiPersistenceEnabled,
  view,
  productState,
  reviewsNonce
}: UseServerReviewsArgs) {
  const [serverReviews, setServerReviews] = useState<ReviewsResponse | null>(null);
  const [reviewsError, setReviewsError] = useState<string | null>(null);
  const [reviewsLoading, setReviewsLoading] = useState(false);

  // Avoid re-fetching on every autosave revision tick: count-based asset signature.
  const assetSig = useMemo(
    () =>
      `${productState.revision}:${productState.points.length}:${productState.decisions.length}:${productState.themes.length}`,
    [
      productState.revision,
      productState.points.length,
      productState.decisions.length,
      productState.themes.length
    ]
  );

  const [debouncedSig, setDebouncedSig] = useState(assetSig);
  useEffect(() => {
    if (!apiPersistenceEnabled || !REVIEWS_VIEWS.has(view)) return;
    const t = setTimeout(() => setDebouncedSig(assetSig), DEBOUNCE_MS);
    return () => clearTimeout(t);
  }, [apiPersistenceEnabled, view, assetSig]);

  useEffect(() => {
    if (!apiPersistenceEnabled || !REVIEWS_VIEWS.has(view)) return;
    let cancelled = false;
    setReviewsLoading(true);
    productApiClient
      .getReviews()
      .then((r) => {
        if (cancelled) return;
        setServerReviews(r);
        setReviewsError(null);
      })
      .catch((e) => {
        if (cancelled) return;
        setReviewsError(e instanceof Error ? e.message : String(e));
        // Keep stale serverReviews on 503/429/network — radar falls back to localRadar.
      })
      .finally(() => {
        if (!cancelled) setReviewsLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [apiPersistenceEnabled, view, debouncedSig, reviewsNonce]);

  return { serverReviews, reviewsError, reviewsLoading };
}
