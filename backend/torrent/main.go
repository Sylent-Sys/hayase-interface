package main

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"log"
	"net/http"
	"os"
	"os/signal"
	"path/filepath"
	"strconv"
	"strings"
	"sync"
	"syscall"
	"time"

	"github.com/anacrolix/torrent"
)

var (
	client        *torrent.Client
	stateMu       sync.RWMutex
	sessions      = map[string]*SessionState{}
	torrentByHash = map[string]*torrent.Torrent{}
	torrentRefs   = map[string]int{}
	speedByHash   = map[string]*SpeedRecord{}
)

var (
	maxTorrents     = getEnvInt("MAX_TORRENTS", 200)
	sessionTTL      = time.Duration(getEnvInt("SESSION_TTL_SECONDS", 1800)) * time.Second
	cleanupInterval = time.Duration(getEnvInt("CLEANUP_INTERVAL_SECONDS", 300)) * time.Second
	shutdownTimeout = time.Duration(getEnvInt("SHUTDOWN_TIMEOUT_SECONDS", 15)) * time.Second
	drainOnShutdown = getEnvBool("DRAIN_TORRENTS_ON_SHUTDOWN", false)
)

var errMaxTorrentCapacity = errors.New("maximum torrent capacity reached")

type InfoHashString string

type SpeedRecord struct {
	Mu        sync.Mutex
	LastBytes int64
	LastTime  time.Time
	Speed     float64
}

type SessionState struct {
	Torrents map[string]struct{}
	LastSeen time.Time
}

// Used to return basic file structure
type FileInfo struct {
	Name   string `json:"name"`
	Path   string `json:"path"`
	Length int64  `json:"length"`
	Index  int    `json:"index"`
}

type TorrentStatus struct {
	InfoHash   string  `json:"infoHash"`
	Name       string  `json:"name"`
	Progress   float64 `json:"progress"`
	Total      int64   `json:"total"`
	Downloaded int64   `json:"downloaded"`
	Uploaded   int64   `json:"uploaded"`
	DownSpeed  float64 `json:"downSpeed"`
	UpSpeed    float64 `json:"upSpeed"`
	Peers      int     `json:"peers"`
	Ready      bool    `json:"ready"`
	Pieces     int     `json:"pieces"`
	PieceSize  int64   `json:"pieceSize"`
}

func main() {
	tmpDir := filepath.Join(os.TempDir(), "webtorrent")
	_ = os.MkdirAll(tmpDir, 0o755)

	config := torrent.NewDefaultClientConfig()
	config.DataDir = tmpDir
	config.ListenPort = 6881
	config.NoDHT = false

	var err error
	client, err = torrent.NewClient(config)
	if err != nil {
		log.Fatalf("Error adding torrent client: %s", err)
	}

	mux := http.NewServeMux()
	mux.HandleFunc("/add", withRequestLogging("add", handleAdd))
	mux.HandleFunc("/remove", withRequestLogging("remove", handleRemove))
	mux.HandleFunc("/remove-all", withRequestLogging("remove-all", handleRemoveAll))
	mux.HandleFunc("/status/", withRequestLogging("status", handleStatus))
	mux.HandleFunc("/stream/", withRequestLogging("stream", handleStream))
	mux.HandleFunc("/metrics", withRequestLogging("metrics", handleMetrics))

	server := &http.Server{
		Addr:    ":5000",
		Handler: mux,
	}

	workerCtx, workerCancel := context.WithCancel(context.Background())
	go startCleanupWorker(workerCtx)
	go startSpeedWorker(workerCtx)

	serverErrCh := make(chan error, 1)
	go func() {
		logKV("server_start", "addr", server.Addr)
		err := server.ListenAndServe()
		if err != nil && !errors.Is(err, http.ErrServerClosed) {
			serverErrCh <- err
			return
		}
		serverErrCh <- nil
	}()

	sigCtx, stopSignals := signal.NotifyContext(context.Background(), syscall.SIGINT, syscall.SIGTERM)
	defer stopSignals()

	var runErr error
	select {
	case runErr = <-serverErrCh:
	case <-sigCtx.Done():
		logKV("shutdown_signal", "reason", sigCtx.Err())
	}

	workerCancel()

	shutdownCtx, cancelShutdown := context.WithTimeout(context.Background(), shutdownTimeout)
	defer cancelShutdown()
	if err := server.Shutdown(shutdownCtx); err != nil {
		logKV("server_shutdown_error", "error", err)
	}

	if drainOnShutdown {
		drained := drainActiveTorrents()
		logKV("drain_active_torrents", "count", drained)
	}

	closeTorrentClient(tmpDir)

	if runErr != nil {
		logKV("server_exit_error", "error", runErr)
		os.Exit(1)
	}
}

func getEnvInt(key string, fallback int) int {
	value := strings.TrimSpace(os.Getenv(key))
	if value == "" {
		return fallback
	}
	parsed, err := strconv.Atoi(value)
	if err != nil || parsed <= 0 {
		return fallback
	}
	return parsed
}

func getEnvBool(key string, fallback bool) bool {
	value := strings.TrimSpace(strings.ToLower(os.Getenv(key)))
	switch value {
	case "1", "true", "yes", "on":
		return true
	case "0", "false", "no", "off":
		return false
	case "":
		return fallback
	default:
		return fallback
	}
}

type statusCapturingResponseWriter struct {
	http.ResponseWriter
	status int
}

func (w *statusCapturingResponseWriter) WriteHeader(status int) {
	w.status = status
	w.ResponseWriter.WriteHeader(status)
}

func withRequestLogging(handlerName string, next http.HandlerFunc) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		start := time.Now()
		rw := &statusCapturingResponseWriter{ResponseWriter: w, status: http.StatusOK}
		next(rw, r)
		logKV(
			"request_complete",
			"handler", handlerName,
			"method", r.Method,
			"path", r.URL.Path,
			"status", rw.status,
			"duration_ms", time.Since(start).Milliseconds(),
		)
	}
}

func logKV(message string, kv ...any) {
	if len(kv) == 0 {
		log.Print(message)
		return
	}
	if len(kv)%2 != 0 {
		kv = append(kv, "")
	}
	parts := make([]string, 0, len(kv)/2)
	for i := 0; i+1 < len(kv); i += 2 {
		parts = append(parts, fmt.Sprintf("%v=%v", kv[i], kv[i+1]))
	}
	log.Printf("%s %s", message, strings.Join(parts, " "))
}

func writeJSON(w http.ResponseWriter, status int, payload any) bool {
	body, err := json.Marshal(payload)
	if err != nil {
		logKV("json_marshal_error", "status", status, "error", err)
		http.Error(w, "failed to encode response", http.StatusInternalServerError)
		return false
	}

	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	if _, err := w.Write(append(body, '\n')); err != nil {
		logKV("json_write_error", "status", status, "error", err)
		return false
	}
	return true
}

func ensureRequestContext(w http.ResponseWriter, r *http.Request) bool {
	if err := r.Context().Err(); err != nil {
		http.Error(w, "request canceled", http.StatusRequestTimeout)
		return false
	}
	return true
}

func getSessionID(w http.ResponseWriter, r *http.Request) (string, bool) {
	sessionID := strings.TrimSpace(r.Header.Get("X-Session-Id"))
	if sessionID == "" {
		http.Error(w, "missing X-Session-Id header", http.StatusBadRequest)
		return "", false
	}
	return sessionID, true
}

func getOrCreateSessionLocked(sessionID string) *SessionState {
	s, ok := sessions[sessionID]
	if !ok {
		s = &SessionState{
			Torrents: map[string]struct{}{},
			LastSeen: time.Now(),
		}
		sessions[sessionID] = s
	}
	s.LastSeen = time.Now()
	return s
}

func getTorrentForSession(sessionID string, hash string) (*torrent.Torrent, bool) {
	stateMu.RLock()
	defer stateMu.RUnlock()
	s, ok := sessions[sessionID]
	if !ok {
		return nil, false
	}
	if _, owns := s.Torrents[hash]; !owns {
		return nil, false
	}
	t, exists := torrentByHash[hash]
	return t, exists
}

func registerTorrentForSessionLocked(sessionID string, hash string, t *torrent.Torrent) error {
	session := getOrCreateSessionLocked(sessionID)
	if _, owns := session.Torrents[hash]; owns {
		return nil
	}

	if _, existsGlobal := torrentByHash[hash]; !existsGlobal {
		if len(torrentByHash) >= maxTorrents {
			return errMaxTorrentCapacity
		}
		torrentByHash[hash] = t
		torrentRefs[hash] = 1
		speedByHash[hash] = &SpeedRecord{LastTime: time.Now()}
	} else {
		torrentRefs[hash]++
	}

	session.Torrents[hash] = struct{}{}
	return nil
}

func registerTorrentForSession(sessionID string, hash string, t *torrent.Torrent) error {
	stateMu.Lock()
	defer stateMu.Unlock()
	return registerTorrentForSessionLocked(sessionID, hash, t)
}

func releaseTorrentForSession(sessionID string, hash string) bool {
	var toDrop *torrent.Torrent

	stateMu.Lock()
	s, ok := sessions[sessionID]
	if !ok {
		stateMu.Unlock()
		return false
	}
	if _, owns := s.Torrents[hash]; !owns {
		stateMu.Unlock()
		return false
	}

	delete(s.Torrents, hash)
	s.LastSeen = time.Now()

	if refs, exists := torrentRefs[hash]; exists {
		refs--
		if refs <= 0 {
			toDrop = torrentByHash[hash]
			delete(torrentRefs, hash)
			delete(torrentByHash, hash)
			delete(speedByHash, hash)
		} else {
			torrentRefs[hash] = refs
		}
	}
	stateMu.Unlock()

	if toDrop != nil {
		toDrop.Drop()
	}
	return true
}

func startCleanupWorker(ctx context.Context) {
	ticker := time.NewTicker(cleanupInterval)
	defer ticker.Stop()

	for {
		select {
		case <-ticker.C:
			cleanupExpiredSessions()
		case <-ctx.Done():
			logKV("cleanup_worker_stopped")
			return
		}
	}
}

func startSpeedWorker(ctx context.Context) {
	ticker := time.NewTicker(1 * time.Second)
	defer ticker.Stop()

	for {
		select {
		case <-ticker.C:
			updateTorrentSpeeds()
		case <-ctx.Done():
			logKV("speed_worker_stopped")
			return
		}
	}
}

func cleanupExpiredSessions() {
	now := time.Now()
	toDrop := make([]*torrent.Torrent, 0)

	stateMu.Lock()
	for sessionID, session := range sessions {
		if now.Sub(session.LastSeen) <= sessionTTL {
			continue
		}

		for hash := range session.Torrents {
			if refs, ok := torrentRefs[hash]; ok {
				refs--
				if refs <= 0 {
					if t, exists := torrentByHash[hash]; exists {
						toDrop = append(toDrop, t)
					}
					delete(torrentRefs, hash)
					delete(torrentByHash, hash)
					delete(speedByHash, hash)
				} else {
					torrentRefs[hash] = refs
				}
			}
		}

		delete(sessions, sessionID)
		logKV("session_evicted", "session", sessionID)
	}
	stateMu.Unlock()

	for _, t := range toDrop {
		t.Drop()
	}
}

func updateTorrentSpeeds() {
	stateMu.RLock()
	tracked := make(map[string]struct {
		rec *SpeedRecord
		t   *torrent.Torrent
	}, len(speedByHash))
	for hash, rec := range speedByHash {
		tracked[hash] = struct {
			rec *SpeedRecord
			t   *torrent.Torrent
		}{
			rec: rec,
			t:   torrentByHash[hash],
		}
	}
	stateMu.RUnlock()

	now := time.Now()
	for _, item := range tracked {
		if item.rec == nil || item.t == nil {
			continue
		}
		downloaded := item.t.BytesCompleted()
		item.rec.Mu.Lock()
		dur := now.Sub(item.rec.LastTime).Seconds()
		if dur > 0 {
			item.rec.Speed = float64(downloaded-item.rec.LastBytes) / dur
			item.rec.LastBytes = downloaded
			item.rec.LastTime = now
		}
		item.rec.Mu.Unlock()
	}
}

func drainActiveTorrents() int {
	stateMu.Lock()
	toDrop := make([]*torrent.Torrent, 0, len(torrentByHash))
	for _, t := range torrentByHash {
		if t != nil {
			toDrop = append(toDrop, t)
		}
	}
	sessions = map[string]*SessionState{}
	torrentByHash = map[string]*torrent.Torrent{}
	torrentRefs = map[string]int{}
	speedByHash = map[string]*SpeedRecord{}
	stateMu.Unlock()

	for _, t := range toDrop {
		t.Drop()
	}
	return len(toDrop)
}

func closeTorrentClient(tmpDir string) {
	if client != nil {
		client.Close()
	}
	if err := os.RemoveAll(tmpDir); err != nil {
		logKV("tmpdir_cleanup_error", "dir", tmpDir, "error", err)
		return
	}
	logKV("tmpdir_cleaned", "dir", tmpDir)
}

func buildFileList(t *torrent.Torrent) []FileInfo {
	torrentFiles := t.Files()
	files := make([]FileInfo, 0, len(torrentFiles))
	for i, f := range torrentFiles {
		files = append(files, FileInfo{
			Name:   filepath.Base(f.DisplayPath()),
			Path:   f.DisplayPath(),
			Length: f.Length(),
			Index:  i,
		})
	}
	return files
}

func handleAdd(w http.ResponseWriter, r *http.Request) {
	if !ensureRequestContext(w, r) {
		return
	}
	sessionID, ok := getSessionID(w, r)
	if !ok {
		return
	}

	magnet := r.URL.Query().Get("magnet")
	if magnet == "" {
		http.Error(w, "missing magnet query param", http.StatusBadRequest)
		return
	}

	t, err := client.AddMagnet(magnet)
	if err != nil {
		http.Error(w, err.Error(), http.StatusInternalServerError)
		return
	}

	// Wait for metadata with timeout
	ctx := r.Context()
	select {
	case <-t.GotInfo():
	case <-ctx.Done():
		t.Drop()
		http.Error(w, "request canceled", http.StatusRequestTimeout)
		return
	case <-time.After(60 * time.Second):
		t.Drop()
		http.Error(w, "Timeout waiting for metadata", http.StatusGatewayTimeout)
		return
	}

	hash := t.InfoHash().HexString()

	if err := registerTorrentForSession(sessionID, hash, t); err != nil {
		if errors.Is(err, errMaxTorrentCapacity) {
			t.Drop()
			http.Error(w, err.Error(), http.StatusServiceUnavailable)
			return
		}
		t.Drop()
		http.Error(w, "failed to register torrent", http.StatusInternalServerError)
		return
	}

	files := buildFileList(t)

	logKV("torrent_added", "session", sessionID, "name", t.Name(), "hash", hash, "files", len(files))

	_ = writeJSON(w, http.StatusOK, map[string]interface{}{
		"infoHash": hash,
		"name":     t.Name(),
		"files":    files,
	})
}

func handleRemove(w http.ResponseWriter, r *http.Request) {
	if !ensureRequestContext(w, r) {
		return
	}
	sessionID, ok := getSessionID(w, r)
	if !ok {
		return
	}

	hash := strings.TrimSpace(r.URL.Query().Get("hash"))
	if hash == "" {
		http.Error(w, "missing hash query param", http.StatusBadRequest)
		return
	}

	if !releaseTorrentForSession(sessionID, hash) {
		http.Error(w, "torrent not found for session", http.StatusNotFound)
		return
	}

	_ = writeJSON(w, http.StatusOK, map[string]any{"removed": hash})
}

func handleRemoveAll(w http.ResponseWriter, r *http.Request) {
	if !ensureRequestContext(w, r) {
		return
	}
	sessionID, ok := getSessionID(w, r)
	if !ok {
		return
	}

	stateMu.RLock()
	s, exists := sessions[sessionID]
	if !exists {
		stateMu.RUnlock()
		_ = writeJSON(w, http.StatusOK, map[string]any{"removed": 0})
		return
	}
	hashes := make([]string, 0, len(s.Torrents))
	for hash := range s.Torrents {
		hashes = append(hashes, hash)
	}
	stateMu.RUnlock()

	removed := 0
	for _, hash := range hashes {
		if r.Context().Err() != nil {
			logKV("request_canceled", "handler", "remove-all", "session", sessionID)
			return
		}
		if releaseTorrentForSession(sessionID, hash) {
			removed++
		}
	}

	_ = writeJSON(w, http.StatusOK, map[string]any{"removed": removed})
}

func handleStatus(w http.ResponseWriter, r *http.Request) {
	if !ensureRequestContext(w, r) {
		return
	}
	sessionID, ok := getSessionID(w, r)
	if !ok {
		return
	}

	parts := strings.Split(r.URL.Path, "/")
	if len(parts) < 3 {
		http.Error(w, "Invalid path", http.StatusBadRequest)
		return
	}
	hash := parts[2]

	t, exists := getTorrentForSession(sessionID, hash)

	if !exists || t == nil {
		http.Error(w, "Torrent not found", http.StatusNotFound)
		return
	}

	downloaded := t.BytesCompleted()

	// Read cached speed updated by the background worker.
	var speed float64
	stateMu.RLock()
	rec, hasRec := speedByHash[hash]
	stateMu.RUnlock()
	if hasRec {
		rec.Mu.Lock()
		speed = rec.Speed
		rec.Mu.Unlock()
	}

	progress := float64(0)
	total := int64(0)
	if t.Info() != nil {
		total = t.Length()
		if total > 0 {
			progress = float64(downloaded) / float64(total)
		}
	}

	pieces := 0
	pieceSize := int64(0)
	if t.Info() != nil {
		pieces = t.NumPieces()
		pieceSize = t.Info().PieceLength
	}

	stats := t.Stats()
	peers := stats.ActivePeers

	status := TorrentStatus{
		InfoHash:   hash,
		Name:       t.Name(),
		Progress:   progress,
		Total:      total,
		Downloaded: downloaded,
		Uploaded:   stats.BytesWrittenData.Int64(),
		DownSpeed:  speed,
		Peers:      peers,
		Ready:      t.Info() != nil,
		Pieces:     pieces,
		PieceSize:  pieceSize,
	}

	_ = writeJSON(w, http.StatusOK, status)
}

func handleStream(w http.ResponseWriter, r *http.Request) {
	if !ensureRequestContext(w, r) {
		return
	}
	sessionID, ok := getSessionID(w, r)
	if !ok {
		return
	}

	parts := strings.Split(r.URL.Path, "/")
	if len(parts) < 4 {
		http.Error(w, "Invalid path", http.StatusBadRequest)
		return
	}
	hash := parts[2]
	fileIdStr := parts[3]

	fileId, err := strconv.Atoi(fileIdStr)
	if err != nil {
		http.Error(w, "Invalid file ID", http.StatusBadRequest)
		return
	}

	t, exists := getTorrentForSession(sessionID, hash)

	if !exists || t == nil || t.Info() == nil {
		http.Error(w, "Torrent or metadata not found", http.StatusNotFound)
		return
	}

	if fileId < 0 || fileId >= len(t.Files()) {
		http.Error(w, "File ID out of bounds", http.StatusNotFound)
		return
	}

	f := t.Files()[fileId]

	// Create read seeker
	reader := f.NewReader()
	// Set reader to give high priority to pieces that are being read
	reader.SetReadahead(10 * 1024 * 1024) // 10MB
	reader.SetResponsive()
	defer reader.Close()

	if !ensureRequestContext(w, r) {
		return
	}

	http.ServeContent(w, r, filepath.Base(f.DisplayPath()), time.Time{}, reader)
}

func handleMetrics(w http.ResponseWriter, r *http.Request) {
	if !ensureRequestContext(w, r) {
		return
	}
	stateMu.RLock()
	activeSessions := len(sessions)
	activeTorrents := len(torrentByHash)
	stateMu.RUnlock()

	_ = writeJSON(w, http.StatusOK, map[string]any{
		"activeSessions": activeSessions,
		"activeTorrents": activeTorrents,
		"maxTorrents":    maxTorrents,
		"sessionTTL":     sessionTTL.String(),
	})
}
