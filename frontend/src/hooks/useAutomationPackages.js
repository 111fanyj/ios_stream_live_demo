import { useCallback, useEffect, useState } from 'react';
import { fetchAutomationPackages, fetchPackageDetail, saveAutomationPackage } from '../lib/api';

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

  const refreshPackages = useCallback(async () => {
    setPackagesState((current) => ({ ...current, loading: true, error: '' }));
    try {
      const data = await fetchAutomationPackages(baseUrl);
      setPackagesState({
        packages: data.packages || [],
        loading: false,
        error: ''
      });
      return data;
    } catch (error) {
      setPackagesState({
        packages: [],
        loading: false,
        error: error.message || 'Failed to load packages'
      });
      throw error;
    }
  }, [baseUrl]);

  useEffect(() => {
    let cancelled = false;

    refreshPackages().catch((error) => {
      if (!cancelled) {
        setPackagesState({
          packages: [],
          loading: false,
          error: error.message || 'Failed to load packages'
        });
      }
    });

    return () => {
      cancelled = true;
    };
  }, [refreshPackages]);

  const selectPackage = useCallback(async (packageId, revision) => {
    setDetailState({ detail: null, loading: true, error: '' });
    try {
      const detail = await fetchPackageDetail(baseUrl, packageId, revision);
      setDetailState({ detail, loading: false, error: '' });
    } catch (error) {
      setDetailState({ detail: null, loading: false, error: error.message || 'Failed to load package detail' });
    }
  }, [baseUrl]);

  const publishPackage = useCallback(async (automation, images) => {
    const result = await saveAutomationPackage(baseUrl, automation, images);
    await refreshPackages();
    return result.revision;
  }, [baseUrl, refreshPackages]);

  return {
    ...packagesState,
    detail: detailState.detail,
    detailLoading: detailState.loading,
    detailError: detailState.error,
    selectPackage,
    refreshPackages,
    publishPackage
  };
}