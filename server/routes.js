const express = require('express');
const path = require('path');

function registerRoutes(app, runtime) {
  const {
    rooms,
    isClientOpen,
    getCalibrationApp,
    getCalibrationSummary,
    listPackageIds,
    readPackageMetadata,
    saveAutomationPackage,
    sanitizePackageId,
    writeJSON,
    metadataPath,
    revisionDirectory
  } = runtime;

  app.use(express.json({ limit: '30mb' }));
  app.use(express.static(path.join(__dirname, 'public')));
  
  app.get('/health', (_req, res) => {
    const roomSummary = Array.from(rooms.entries()).map(([roomId, room]) => ({
      roomId,
      hasPublisher: isClientOpen(room.publisher),
      hasExecutor: isClientOpen(room.executor),
      hasCalibrationApp: isClientOpen(getCalibrationApp(roomId)),
      calibrationAppId: room.calibrationAppId,
      calibration: getCalibrationSummary(room),
      viewerCount: room.viewers.size,
      probeCount: room.probes.size,
      publisherConnectedAt: room.publisherConnectedAt,
      executorConnectedAt: room.executorConnectedAt,
      transport: 'webrtc-video-track'
    }));
  
    res.json({ ok: true, rooms: roomSummary });
  });
  
  app.get('/api/automation/packages', async (_req, res, next) => {
    try {
      const packageIds = await listPackageIds();
      const packages = await Promise.all(packageIds.map(readPackageMetadata));
      res.json({ packages });
    } catch (error) {
      next(error);
    }
  });
  
  app.post('/api/automation/packages', async (req, res, next) => {
    try {
      const revision = await saveAutomationPackage(req.body);
      res.status(201).json({ ok: true, revision });
    } catch (error) {
      next(error);
    }
  });
  
  app.get('/api/automation/packages/:packageId', async (req, res, next) => {
    try {
      const packageId = sanitizePackageId(req.params.packageId);
      if (!packageId) {
        res.status(400).json({ error: 'Invalid packageId' });
        return;
      }
  
      const metadata = await readPackageMetadata(packageId);
      if (metadata.latestRevision === 0) {
        res.status(404).json({ error: 'Package not found' });
        return;
      }
  
      res.json(metadata);
    } catch (error) {
      next(error);
    }
  });
  
  app.post('/api/automation/packages/:packageId/active', async (req, res, next) => {
    try {
      const packageId = sanitizePackageId(req.params.packageId);
      const revision = Number(req.body?.revision);
      if (!packageId || !Number.isInteger(revision) || revision < 1) {
        res.status(400).json({ error: 'Invalid packageId or revision' });
        return;
      }
  
      const metadata = await readPackageMetadata(packageId);
      if (!metadata.revisions.some((entry) => entry.revision === revision)) {
        res.status(404).json({ error: 'Revision not found' });
        return;
      }
  
      metadata.activeRevision = revision;
      metadata.updatedAt = new Date().toISOString();
      await writeJSON(metadataPath(packageId), metadata);
      res.json({ ok: true, packageId, activeRevision: revision });
    } catch (error) {
      next(error);
    }
  });
  
  app.get('/api/automation/packages/:packageId/download', async (req, res, next) => {
    try {
      const packageId = sanitizePackageId(req.params.packageId);
      if (!packageId) {
        res.status(400).json({ error: 'Invalid packageId' });
        return;
      }
  
      const metadata = await readPackageMetadata(packageId);
      const requestedRevision = req.query.revision === 'latest' || !req.query.revision
        ? metadata.latestRevision
        : Number(req.query.revision);
      const revision = Number.isInteger(requestedRevision) ? requestedRevision : Number(requestedRevision);
      if (!revision || !metadata.revisions.some((entry) => entry.revision === revision)) {
        res.status(404).json({ error: 'Revision not found' });
        return;
      }
  
      const zipPath = path.join(revisionDirectory(packageId, revision), 'package.zip');
      res.download(zipPath, `${packageId}-r${revision}.zip`);
    } catch (error) {
      next(error);
    }
  });
  
}

module.exports = { registerRoutes };
