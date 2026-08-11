import { useEffect, useState } from "react";
import { productApiClient, type PersistHealthLite } from "../api/productApi";

const HEALTH_POLL_MS = 30_000;

/**
 * B7: poll GET /api/health every 30s while API persistence is online.
 * Drives the top-bar persist degraded banner (N-02).
 * Network failures do not fake persist degraded.
 */
export function usePersistHealthPoll(apiPersistenceEnabled: boolean): PersistHealthLite | null {
  const [persistHealth, setPersistHealth] = useState<PersistHealthLite | null>(null);

  useEffect(() => {
    if (!apiPersistenceEnabled) {
      setPersistHealth(null);
      return;
    }
    let cancelled = false;
    const tick = async () => {
      try {
        const h = await productApiClient.getHealth();
        if (cancelled) return;
        if (h.persist?.degraded) {
          setPersistHealth({
            consecutiveFailures: h.persist.consecutiveFailures,
            lastErrorAt: h.persist.lastErrorAt
          });
        } else {
          setPersistHealth(null);
        }
      } catch {
        // Network failure ≠ persist degraded; leave prior banner state or stay clear.
      }
    };
    void tick();
    const id = setInterval(tick, HEALTH_POLL_MS);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, [apiPersistenceEnabled]);

  return persistHealth;
}
