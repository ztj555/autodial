package main

import (
	"encoding/json"
	"fmt"
	"net"
	"os"
	"sync"
	"time"
)

var udpConn *net.UDPConn
var udpMu sync.Mutex

// Neighbor PCs on LAN (keyed by IP)
var neighbors = make(map[string]time.Time)
var neighborsMu sync.Mutex

func startUDPDiscovery() error {
	addr := &net.UDPAddr{IP: net.IPv4(0, 0, 0, 0), Port: DiscoveryPort}
	conn, err := net.ListenUDP("udp4", addr)
	if err != nil {
		return err
	}
	udpConn = conn
	fileLog("I", "UDP", "", fmt.Sprintf("listening on port %d", DiscoveryPort))

	go func() {
		buf := make([]byte, 1024)
		for {
			n, remote, err := conn.ReadFromUDP(buf)
			if err != nil {
				continue
			}

			var msg map[string]string
			if err := json.Unmarshal(buf[:n], &msg); err != nil {
				continue
			}

			msgType := msg["type"]
			msgPin := msg["pin"]
			remoteIP := remote.IP.String()

			if msgType == "discover" && msgPin == pinCode {
				hostname, _ := os.Hostname()
				localIP := getLocalIP()
				resp, _ := json.Marshal(map[string]string{
					"type":     "found",
					"ip":       localIP,
					"pin":      pinCode,
					"port":     fmt.Sprintf("%d", Port),
					"hostname": hostname,
				})
				conn.WriteToUDP(resp, remote)
				fileLog("I", "UDP", "", "responded to discover from "+remoteIP)
			}

			// Track neighbor PCs (other AutoDial instances on LAN)
			if msgType == "announce" && msgPin != pinCode && remoteIP != getLocalIP() {
				neighborsMu.Lock()
				if _, exists := neighbors[remoteIP]; !exists {
					hostname := msg["hostname"]
					fileLog("I", "UDP", "", "found neighbor PC: "+hostname+" ("+remoteIP+")")
				}
				neighbors[remoteIP] = time.Now()
				neighborsMu.Unlock()
			}
		}
	}()

	// Periodic announce broadcast (对齐原版 10s 间隔)
	go func() {
		broadAddr := &net.UDPAddr{IP: net.IPv4(255, 255, 255, 255), Port: DiscoveryPort}
		for {
			hostname, _ := os.Hostname()
			broadcast, _ := json.Marshal(map[string]string{
				"type":     "announce",
				"pin":      pinCode,
				"ip":       getLocalIP(),
				"port":     fmt.Sprintf("%d", Port),
				"hostname": hostname,
			})
			if udpConn != nil {
				udpMu.Lock()
				conn.WriteToUDP(broadcast, broadAddr)
				udpMu.Unlock()
			}
			time.Sleep(10 * time.Second)
		}
	}()

	// Cleanup stale neighbors every 30s
	go func() {
		for {
			time.Sleep(30 * time.Second)
			neighborsMu.Lock()
			for ip, lastSeen := range neighbors {
				if time.Since(lastSeen) > NeighborTTL {
					delete(neighbors, ip)
				}
			}
			neighborsMu.Unlock()
		}
	}()

	return nil
}

func stopUDPDiscovery() {
	udpMu.Lock()
	defer udpMu.Unlock()
	if udpConn != nil {
		udpConn.Close()
		udpConn = nil
	}
}

// GetNeighborCount returns the number of other AutoDial PCs on LAN
func GetNeighborCount() int {
	neighborsMu.Lock()
	defer neighborsMu.Unlock()
	return len(neighbors)
}
