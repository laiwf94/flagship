import { useCallback, useEffect, useRef, useState } from 'react';
import { ApiError } from './api';

export interface Resource<T> {
  data: T | undefined;
  error: ApiError | undefined;
  loading: boolean;
  reload: () => void;
  set: (data: T) => void;
}

interface Loaded<T> {
  /** Which request this answers: the key plus a reload counter. */
  token: string;
  key: string;
  data?: T | undefined;
  error?: ApiError | undefined;
}

/**
 * Loads data when `key` changes and ignores answers that arrive after a newer
 * request started, so switching environments quickly never shows stale rows.
 * A reload of the same key keeps showing the old data until the new arrives.
 */
export function useResource<T>(load: () => Promise<T>, key: string): Resource<T> {
  const [tick, setTick] = useState(0);
  const [loaded, setLoaded] = useState<Loaded<T> | undefined>();
  const loadRef = useRef(load);
  useEffect(() => {
    loadRef.current = load;
  });
  const token = `${key}#${tick}`;

  useEffect(() => {
    let current = true;
    loadRef
      .current()
      .then((data) => {
        if (current) setLoaded({ token, key, data });
      })
      .catch((err: unknown) => {
        if (!current) return;
        const error =
          err instanceof ApiError
            ? err
            : new ApiError(0, 'internal', 'Something went wrong.', undefined);
        setLoaded({ token, key, error });
      });
    return () => {
      current = false;
    };
  }, [token, key]);

  const reload = useCallback(() => {
    setTick((t) => t + 1);
  }, []);
  const set = useCallback(
    (data: T) => {
      setLoaded({ token, key, data });
    },
    [token, key],
  );
  const sameKey = loaded?.key === key;
  const fresh = loaded?.token === token;
  return {
    data: sameKey ? loaded.data : undefined,
    error: fresh ? loaded.error : undefined,
    loading: !fresh,
    reload,
    set,
  };
}
