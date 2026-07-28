package main

import (
	"archive/zip"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"sync"
	"time"
)

const (
	MaxLogSize = 10 * 1024 * 1024
	MaxLogDays = 7
)

var (
	logDir     string
	logMu      sync.Mutex
	logFailCnt int
	logBuffer  []string
	logBufMax  = 1000
)

func initLogger() error {
	cfgDir, err := os.UserConfigDir()
	if err != nil {
		cfgDir = filepath.Join(os.Getenv("APPDATA"), "autodial-pc")
	}
	logDir = filepath.Join(cfgDir, "autodial-logs")
	if err := os.MkdirAll(logDir, 0755); err != nil {
		return err
	}
	cleanOldLogs()
	return nil
}

func logFilePath() string {
	return filepath.Join(logDir, fmt.Sprintf("autodial-pc-%s.log", time.Now().Format("2006-01-02")))
}

func fileLog(level, module, pin, msg string) {
	logMu.Lock()
	defer logMu.Unlock()

	now := time.Now()
	ts := fmt.Sprintf("%02d:%02d:%02d.%03d", now.Hour(), now.Minute(), now.Second(), now.Nanosecond()/1000000)
	pinStr := "[----]"
	if pin != "" {
		pinStr = "[" + pin + "]"
	}
	line := fmt.Sprintf("%s [%s] [%s] %s %s\n", ts, level, module, pinStr, msg)

	fp := logFilePath()
	if fi, err := os.Stat(fp); err == nil && fi.Size() >= MaxLogSize {
		alt := fp[:len(fp)-4] + ".1.log"
		os.Rename(fp, alt)
		// Compress old log in background
		go compressOldLog(alt)
	}

	f, err := os.OpenFile(fp, os.O_APPEND|os.O_CREATE|os.O_WRONLY, 0644)
	if err != nil {
		logFailCnt++
		if logFailCnt >= 3 {
			logBuffer = append(logBuffer, line)
			if len(logBuffer) > logBufMax {
				logBuffer = logBuffer[1:]
			}
		}
		return
	}
	defer f.Close()
	f.WriteString(line)
	logFailCnt = 0

	if level == "E" {
		fmt.Fprintf(os.Stderr, "[%s]%s %s", module, pinStr, msg)
	} else if level == "W" {
		fmt.Printf("[%s]%s %s\n", module, pinStr, msg)
	}
}

func cleanOldLogs() {
	cutoff := time.Now().AddDate(0, 0, -MaxLogDays)
	files, err := os.ReadDir(logDir)
	if err != nil {
		return
	}
	for _, f := range files {
		ext := filepath.Ext(f.Name())
		if ext == ".log" || ext == ".zip" {
			info, err := f.Info()
			if err == nil && info.ModTime().Before(cutoff) {
				os.Remove(filepath.Join(logDir, f.Name()))
			}
		}
	}
}

func compressOldLog(srcPath string) {
	zipPath := srcPath[:len(srcPath)-4] + ".zip"
	zipFile, err := os.Create(zipPath)
	if err != nil {
		return
	}
	defer zipFile.Close()

	zw := zip.NewWriter(zipFile)
	defer zw.Close()

	srcFile, err := os.Open(srcPath)
	if err != nil {
		return
	}
	defer srcFile.Close()

	info, err := srcFile.Stat()
	if err != nil {
		return
	}

	header, err := zip.FileInfoHeader(info)
	if err != nil {
		return
	}
	header.Name = filepath.Base(srcPath)
	header.Method = zip.Deflate

	writer, err := zw.CreateHeader(header)
	if err != nil {
		return
	}
	io.Copy(writer, srcFile)

	// Remove the original .1.log after successful compression
	srcFile.Close()
	os.Remove(srcPath)
}
