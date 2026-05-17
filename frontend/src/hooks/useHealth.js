import { useEffect, useState } from 'react';
import { fetchHealth } from '../lib/api';

export function useHealth(baseUrl) {
  const [state, setState] = useState({
    data: null,
    loading: true,
    error: ''
  });

  useEffect(() => {
    let cancelled = false;

    async function load() {
      try {
        setState((current) => ({ ...current, loading: true, error: '' }));
        const data = await fetchHealth(baseUrl);
        if (!cancelled) {
          setState({ data, loading: false, error: '' });
        }
      } catch (error) {
        if (!cancelled) {
          setState({ data: null, loading: false, error: error.message || 'Failed to load health data' });
        }
      }
    }

    load();
    const intervalId = window.setInterval(load, 5000);

    return () => {
      cancelled = true;
      window.clearInterval(intervalId);
    };
  }, [baseUrl]);

  return state;
}