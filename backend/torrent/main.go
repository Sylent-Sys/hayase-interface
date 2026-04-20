package main

import (
	"encoding/json"
	"log"
	"net/http"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/anacrolix/torrent"
)

var client *torrent.Client
var speeds sync.Map

type InfoHashString string

type SpeedRecord struct {
	LastBytes int64
	LastTime  time.Time
	Speed     float64
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
	_ = os.MkdirAll(tmpDir, 0755)

	config := torrent.NewDefaultClientConfig()
	config.DataDir = tmpDir
	config.ListenPort = 6881
	config.NoDHT = false

	var err error
	client, err = torrent.NewClient(config)
	if err != nil {
		log.Fatalf("Error adding torrent client: %s", err)
	}
	defer client.Close()

	http.HandleFunc("/add", handleAdd)
	http.HandleFunc("/status/", handleStatus)
	http.HandleFunc("/stream/", handleStream)

	log.Println("Torrent service running on port 5000")
	if err := http.ListenAndServe(":5000", nil); err != nil {
		log.Fatalf("Failed to start server: %s", err)
	}
}

func handleAdd(w http.ResponseWriter, r *http.Request) {
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
	select {
	case <-t.GotInfo():
	case <-time.After(60 * time.Second):
		http.Error(w, "Timeout waiting for metadata", http.StatusGatewayTimeout)
		return
	}

	// Make sure we have a struct for speeds
	speeds.Store(t.InfoHash().HexString(), &SpeedRecord{
		LastTime: time.Now(),
	})

	files := []FileInfo{}
	for i, f := range t.Files() {
		files = append(files, FileInfo{
			Name:   filepath.Base(f.DisplayPath()),
			Path:   f.DisplayPath(),
			Length: f.Length(),
			Index:  i,
		})
	}

	infoHash := t.InfoHash().HexString()
	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(map[string]interface{}{
		"infoHash": infoHash,
		"name":     t.Name(),
		"files":    files,
	})
}

func handleStatus(w http.ResponseWriter, r *http.Request) {
	parts := strings.Split(r.URL.Path, "/")
	if len(parts) < 3 {
		http.Error(w, "Invalid path", http.StatusBadRequest)
		return
	}
	hash := parts[2]
	
	var t *torrent.Torrent
	for _, tr := range client.Torrents() {
		if tr.InfoHash().HexString() == hash {
			t = tr
			break
		}
	}

	if t == nil {
		http.Error(w, "Torrent not found", http.StatusNotFound)
		return
	}

	downloaded := t.BytesCompleted()

	// Calculate speed
	var speed float64
	record, ok := speeds.Load(hash)
	if ok {
		rec := record.(*SpeedRecord)
		now := time.Now()
		dur := now.Sub(rec.LastTime).Seconds()
		if dur > 1 {
			speed = float64(downloaded-rec.LastBytes) / dur
			rec.LastBytes = downloaded
			rec.LastTime = now
		} else {
			speed = rec.Speed
		}
		rec.Speed = speed
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

	peers := t.Stats().ActivePeers

	status := TorrentStatus{
		InfoHash:   hash,
		Name:       t.Name(),
		Progress:   progress,
		Total:      total,
		Downloaded: downloaded,
		Uploaded:   0, // Not easily exposed without deeper stats
		DownSpeed:  speed,
		Peers:      peers,
		Ready:      t.Info() != nil,
		Pieces:     pieces,
		PieceSize:  pieceSize,
	}

	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(status)
}

func handleStream(w http.ResponseWriter, r *http.Request) {
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

	var t *torrent.Torrent
	for _, tr := range client.Torrents() {
		if tr.InfoHash().HexString() == hash {
			t = tr
			break
		}
	}

	if t == nil || t.Info() == nil {
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

	http.ServeContent(w, r, filepath.Base(f.DisplayPath()), time.Time{}, reader)
}
