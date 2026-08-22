package main

import (
	"net"
	"net/http"
	"net/url"
	"strings"
)

// isLoopbackHost 校验 Host 头是否为回环地址/主机名（防 DNS rebinding：
// 攻击者域名解析到 127.0.0.1 时 Host 为攻击者域名，将被拒绝）。
func isLoopbackHost(host string) bool {
	h := strings.ToLower(strings.TrimSpace(host))
	if i := strings.LastIndex(h, ":"); i >= 0 {
		if strings.HasPrefix(h, "[") {
			// IPv6 字面量 [::1]:port
			if j := strings.Index(h, "]"); j >= 0 {
				h = h[1:j]
			} else {
				h = h[:i]
			}
		} else {
			h = h[:i]
		}
	}
	return h == "localhost" || h == "127.0.0.1" || h == "::1"
}

// isTrustedLocalOrigin 校验 HTTP Origin 是否来自可信本地来源。
// 允许：Chrome 扩展 chrome-extension://、Electron file://、回环 http(s)://。
// C1修复: 空/无来源（curl 等命令行工具）与 file:// 的 "null" 来源一律拒绝；
// 回环来源改为精确 host 校验（localhost/127.0.0.1/::1），杜绝
// http://localhost.evil.com 之类前缀绕过。
func isTrustedLocalOrigin(origin string) bool {
	o := strings.ToLower(strings.TrimSpace(origin))
	if o == "" || o == "null" {
		return false
	}
	if strings.HasPrefix(o, "chrome-extension://") || strings.HasPrefix(o, "file://") {
		return true
	}
	u, err := url.Parse(o)
	if err != nil {
		return false
	}
	host := u.Host
	if h, _, err := net.SplitHostPort(host); err == nil {
		host = h
	}
	host = strings.Trim(strings.ToLower(host), "[]")
	return host == "localhost" || host == "127.0.0.1" || host == "::1"
}

// rejectUntrustedRequest 校验 HTTP 请求，不合规时写入 403 并返回 true。
// S1修复：本地端口(127.0.0.1:35432)此前无认证 + CORS *，任意网页可静默拨号/发短信；
// 现在要求回环 Host + 可信来源。
func rejectUntrustedRequest(w http.ResponseWriter, r *http.Request) bool {
	if !isLoopbackHost(r.Host) || !isTrustedLocalOrigin(r.Header.Get("Origin")) {
		w.Header().Set("Content-Type", "application/json")
		http.Error(w, `{"ok":false,"code":"FORBIDDEN","message":"forbidden"}`, http.StatusForbidden)
		return true
	}
	return false
}
