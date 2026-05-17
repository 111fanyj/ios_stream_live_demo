import { useCallback, useEffect, useState } from 'react';
import { fetchAutomationPackages, fetchPackageDetail } from '../lib/api';

export function useAutomationPackages(baseUrl) {
  const [packagesState, setPackagesState] = useState({
    packages: [],
    loading: true,
    error: ''
  });
  const [detailState, setDetailState] = useState({
    detail: null,
    loading: false,
    error: ''
  });

  useEffect(() => {
    let cancelled = false;

    async function load() {
      try {
        setPackagesState((current) => ({ ...current, loading: true, error: '' }));
        const data = await fetchAutomationPackages(baseUrl);
        if (!cancelled) {
          setPackagesState({
            packages: data.packages || [],
            loading: false,
            error: ''
          });
        }
      } catch (error) {
        if (!cancelled) {
          setPackagesState({ packages: [], loading: false, error: error.message || 'Failed to load packages' });
        }
      }
    }

    load();

    return () => {
      cancelled = true;
    };
  }, [baseUrl]);

  const selectPackage = useCallback(async (packageId, revision) => {
    setDetailState({ detail: null, loading: true, error: '' });
    try {
      const detail = await fetchPackageDetail(baseUrl, packageId, revision);
      setDetailState({ detail, loading: false, error: '' });
    } catch (error) {
      setDetailState({ detail: null, loading: false, error: error.message || 'Failed to load package detail' });
    }
  }, [baseUrl]);

  return {
    ...packagesState,
    detail: detailState.detail,
    detailLoading: detailState.loading,
    detailError: detailState.error,
    selectPackage
  };
}