package main

import (
	"fmt"
	"sync"
	"sync/atomic"
	"testing"

	"github.com/anacrolix/torrent"
)

func resetStateForTest(t *testing.T) func() {
	t.Helper()

	stateMu.Lock()
	prevSessions := sessions
	prevTorrentByHash := torrentByHash
	prevTorrentRefs := torrentRefs
	prevSpeedByHash := speedByHash
	prevMaxTorrents := maxTorrents

	sessions = map[string]*SessionState{}
	torrentByHash = map[string]*torrent.Torrent{}
	torrentRefs = map[string]int{}
	speedByHash = map[string]*SpeedRecord{}
	stateMu.Unlock()

	return func() {
		stateMu.Lock()
		sessions = prevSessions
		torrentByHash = prevTorrentByHash
		torrentRefs = prevTorrentRefs
		speedByHash = prevSpeedByHash
		maxTorrents = prevMaxTorrents
		stateMu.Unlock()
	}
}

func TestRegisterTorrentForSessionConcurrentCapacity(t *testing.T) {
	restore := resetStateForTest(t)
	defer restore()

	maxTorrents = 2

	const workers = 64
	start := make(chan struct{})
	var wg sync.WaitGroup
	var successCount atomic.Int64
	var capacityCount atomic.Int64

	for i := 0; i < workers; i++ {
		i := i
		wg.Add(1)
		go func() {
			defer wg.Done()
			<-start
			sessionID := fmt.Sprintf("session-%d", i)
			hash := fmt.Sprintf("hash-%d", i)
			err := registerTorrentForSession(sessionID, hash, nil)
			switch {
			case err == nil:
				successCount.Add(1)
			case err == errMaxTorrentCapacity:
				capacityCount.Add(1)
			default:
				t.Errorf("unexpected registration error: %v", err)
			}
		}()
	}

	close(start)
	wg.Wait()

	stateMu.RLock()
	defer stateMu.RUnlock()

	if got := len(torrentByHash); got > maxTorrents {
		t.Fatalf("expected active torrents <= %d, got %d", maxTorrents, got)
	}
	if got := int(successCount.Load()); got != maxTorrents {
		t.Fatalf("expected successful registrations=%d, got %d", maxTorrents, got)
	}
	if got := int(capacityCount.Load()); got != workers-maxTorrents {
		t.Fatalf("expected capacity rejections=%d, got %d", workers-maxTorrents, got)
	}
}

func TestRegisterAndReleaseSharedHashConcurrent(t *testing.T) {
	restore := resetStateForTest(t)
	defer restore()

	maxTorrents = 1000
	sharedHash := "shared-hash"

	const sessionsCount = 80
	startAdd := make(chan struct{})
	var addWG sync.WaitGroup

	for i := 0; i < sessionsCount; i++ {
		i := i
		addWG.Add(1)
		go func() {
			defer addWG.Done()
			<-startAdd
			sessionID := fmt.Sprintf("session-%d", i)
			if err := registerTorrentForSession(sessionID, sharedHash, nil); err != nil {
				t.Errorf("register failed for %s: %v", sessionID, err)
			}
		}()
	}

	close(startAdd)
	addWG.Wait()

	stateMu.RLock()
	if got := len(torrentByHash); got != 1 {
		stateMu.RUnlock()
		t.Fatalf("expected 1 active torrent, got %d", got)
	}
	if refs := torrentRefs[sharedHash]; refs != sessionsCount {
		stateMu.RUnlock()
		t.Fatalf("expected refs=%d, got %d", sessionsCount, refs)
	}
	stateMu.RUnlock()

	startRemove := make(chan struct{})
	var removeWG sync.WaitGroup
	for i := 0; i < sessionsCount; i++ {
		i := i
		removeWG.Add(1)
		go func() {
			defer removeWG.Done()
			<-startRemove
			sessionID := fmt.Sprintf("session-%d", i)
			if ok := releaseTorrentForSession(sessionID, sharedHash); !ok {
				t.Errorf("release failed for %s", sessionID)
			}
		}()
	}

	close(startRemove)
	removeWG.Wait()

	stateMu.RLock()
	defer stateMu.RUnlock()

	if _, ok := torrentByHash[sharedHash]; ok {
		t.Fatalf("expected shared hash to be removed from torrentByHash")
	}
	if _, ok := torrentRefs[sharedHash]; ok {
		t.Fatalf("expected shared hash to be removed from torrentRefs")
	}
	if _, ok := speedByHash[sharedHash]; ok {
		t.Fatalf("expected shared hash to be removed from speedByHash")
	}
}
