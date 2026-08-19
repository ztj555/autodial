"""
QA Test Suite for cloud_relay_v2.py dashboard refactoring
Tests: new API fields, new endpoints, auth boundaries, SQL correctness
"""

import json
import os
import re
import sqlite3
import sys
import tempfile
import unittest
from datetime import datetime

# ============================================================
# TEST 1: Python AST / Compile Check
# ============================================================
class TestSyntaxCompilation(unittest.TestCase):
    """Verify the file compiles without syntax errors."""

    def test_file_compiles(self):
        """cloud_relay_v2.py must pass py_compile without errors."""
        import py_compile
        src = os.path.join(os.path.dirname(__file__), 'cloud_relay_v2.py')
        try:
            py_compile.compile(src, doraise=True)
        except py_compile.PyCompileError as e:
            self.fail(f"Compilation failed: {e}")

    def test_file_is_valid_python(self):
        """AST parse must succeed."""
        import ast
        src = os.path.join(os.path.dirname(__file__), 'cloud_relay_v2.py')
        with open(src, 'r', encoding='utf-8') as f:
            code = f.read()
        try:
            ast.parse(code)
        except SyntaxError as e:
            self.fail(f"AST parse failed: {e}")


# ============================================================
# TEST 2: API Route / Path Existence
# ============================================================
class TestApiRoutesExist(unittest.TestCase):
    """Verify expected API route definitions exist in source."""

    @classmethod
    def setUpClass(cls):
        src = os.path.join(os.path.dirname(__file__), 'cloud_relay_v2.py')
        with open(src, 'r', encoding='utf-8') as f:
            cls.source = f.read()

    def test_api_status_exists(self):
        self.assertIn("path == '/api/status'", self.source)

    def test_api_v1_devices_exists(self):
        self.assertIn("path == '/api/v1/devices'", self.source)

    def test_api_v1_device_history_exists(self):
        self.assertIn("path == '/api/v1/device-history'", self.source)

    def test_api_v1_calls_exists(self):
        self.assertIn("path == '/api/v1/calls'", self.source)

    def test_api_v1_visits_exists(self):
        self.assertIn("path == '/api/v1/visits'", self.source)

    def test_api_v1_pins_exists(self):
        self.assertIn("path == '/api/v1/pins'", self.source)

    def test_api_v1_groups_exists(self):
        self.assertIn("path == '/api/v1/groups'", self.source)

    def test_api_v1_login_exists(self):
        self.assertIn("path == '/api/v1/login'", self.source)

    def test_api_v1_logout_exists(self):
        self.assertIn("path == '/api/v1/logout'", self.source)

    def test_api_v1_visits_batch_exists(self):
        self.assertIn("path == '/api/v1/visits/batch'", self.source)

    def test_api_health_exists(self):
        self.assertIn("path == '/health'", self.source)

    def test_api_clients_exists(self):
        self.assertIn("path == '/api/clients'", self.source)

    def test_api_stats_exists(self):
        self.assertIn("path == '/api/stats'", self.source)

    def test_api_logs_exists(self):
        self.assertIn("path == '/api/logs'", self.source)

    def test_api_history_exists(self):
        self.assertIn("path == '/api/history'", self.source)

    def test_api_kick_exists(self):
        self.assertIn("path == '/api/v1/kick'", self.source)

    def test_dashboard_html_route_exists(self):
        self.assertIn("path == '/' or path == '/index.html'", self.source)


# ============================================================
# TEST 3: New /api/status fields (today_dials, today_visits, recent_active)
# ============================================================
class TestStatusEndpointFields(unittest.TestCase):
    """Verify /api/status endpoint includes the new dashboard fields."""

    @classmethod
    def setUpClass(cls):
        src = os.path.join(os.path.dirname(__file__), 'cloud_relay_v2.py')
        with open(src, 'r', encoding='utf-8') as f:
            cls.source = f.read()
        # Extract the status handler block
        start = cls.source.find("if path == '/api/status':")
        # Find the next top-level route after status
        end = cls.source.find("if path == '/api/clients':", start)
        cls.status_block = cls.source[start:end] if start != -1 and end != -1 else ""

    def test_today_dials_field_present(self):
        """Response must include 'today_dials' key."""
        self.assertIn("'today_dials':", self.status_block)

    def test_today_visits_field_present(self):
        """Response must include 'today_visits' key."""
        self.assertIn("'today_visits':", self.status_block)

    def test_recent_active_field_present(self):
        """Response must include 'recent_active' key."""
        self.assertIn("'recent_active':", self.status_block)

    def test_legacy_fields_preserved(self):
        """Legacy fields must remain in response."""
        legacy = ['service', 'version', 'port', 'uptime_seconds',
                   'total_connections', 'total_groups', 'total_messages',
                   'total_bytes_sent', 'total_bytes_received']
        for field in legacy:
            self.assertIn(f"'{field}':", self.status_block,
                          f"Missing legacy field: {field}")


# ============================================================
# TEST 4: /api/v1/devices new fields (current_pin, current_name)
# ============================================================
class TestDevicesEndpointFields(unittest.TestCase):
    """Verify /api/v1/devices includes current_pin and current_name."""

    @classmethod
    def setUpClass(cls):
        src = os.path.join(os.path.dirname(__file__), 'cloud_relay_v2.py')
        with open(src, 'r', encoding='utf-8') as f:
            cls.source = f.read()
        start = cls.source.find("if path == '/api/v1/devices':")
        end = cls.source.find("if path == '/api/v1/device-history':", start)
        cls.devices_block = cls.source[start:end] if start != -1 and end != -1 else ""

    def test_current_pin_assigned(self):
        self.assertIn("row['current_pin']", self.devices_block)

    def test_current_name_assigned(self):
        self.assertIn("row['current_name']", self.devices_block)

    def test_is_online_assigned(self):
        self.assertIn("row['is_online']", self.devices_block)

    def test_current_ip_assigned(self):
        self.assertIn("row['current_ip']", self.devices_block)

    def test_pin_name_map_used(self):
        """Must query advisor_names to fill current_name."""
        self.assertIn("pin_name_map", self.devices_block)
        self.assertIn("SELECT pin, name FROM advisor_names", self.devices_block)


# ============================================================
# TEST 5: /api/v1/device-history endpoint structure
# ============================================================
class TestDeviceHistoryEndpoint(unittest.TestCase):
    """Verify the new /api/v1/device-history endpoint."""

    @classmethod
    def setUpClass(cls):
        src = os.path.join(os.path.dirname(__file__), 'cloud_relay_v2.py')
        with open(src, 'r', encoding='utf-8') as f:
            cls.source = f.read()
        start = cls.source.find("if path == '/api/v1/device-history':")
        end = cls.source.find("if path == '/api/v1/calls':", start)
        cls.history_block = cls.source[start:end] if start != -1 and end != -1 else ""

    def test_device_id_validation(self):
        """Must reject empty device_id."""
        self.assertIn("device_id 不能为空", self.history_block)

    def test_query_phone_events(self):
        """Must query phone_events table with event_type='login'."""
        self.assertIn("phone_events", self.history_block)
        self.assertIn("event_type='login'", self.history_block)

    def test_name_lookup(self):
        """Must query advisor_names for name completion."""
        self.assertIn("advisor_names", self.history_block)

    def test_response_has_history_key(self):
        """Response must include 'history' key."""
        self.assertIn("'history':", self.history_block)

    def test_response_has_ok_true(self):
        self.assertIn("'ok': True", self.history_block)

    def test_limit_50(self):
        """History query should limit to 50 records."""
        self.assertIn("LIMIT 50", self.history_block)


# ============================================================
# TEST 6: SQL Table Name Correctness (CRITICAL BUG CHECK)
# ============================================================
class TestSQLTableNames(unittest.TestCase):
    """Verify SQL queries reference correct table names."""

    @classmethod
    def setUpClass(cls):
        src = os.path.join(os.path.dirname(__file__), 'cloud_relay_v2.py')
        with open(src, 'r', encoding='utf-8') as f:
            cls.source = f.read()

    def test_status_endpoint_uses_call_records_raw(self):
        """CRITICAL: /api/status must query call_records_raw, NOT call_records."""
        # The table created in init_db is 'call_records_raw'
        self.assertIn("call_records_raw", self.source,
                      "Table call_records_raw must exist in schema")

        # Extract the status handler
        start = self.source.find("if path == '/api/status':")
        end = self.source.find("if path == '/api/clients':", start)
        status_block = self.source[start:end]

        # Check for the BUG: wrong table name
        wrong = "FROM call_records "
        if wrong in status_block:
            self.fail(
                "BUG FOUND: /api/status queries 'call_records' but the actual "
                "table name is 'call_records_raw'. This will cause sqlite3.OperationalError: "
                "no such table: call_records. "
                "Fix: change line 1049 to use 'call_records_raw'."
            )

    def test_calls_endpoint_uses_call_records_raw(self):
        """Calls endpoint correctly uses call_records_raw."""
        start = self.source.find("if path == '/api/v1/calls':")
        end = self.source.find("if path == '/api/v1/kick':", start)
        calls_block = self.source[start:end]
        self.assertIn("call_records_raw", calls_block)


# ============================================================
# TEST 7: Auth Boundary Check (new endpoints must not bypass auth)
# ============================================================
class TestAuthBoundaries(unittest.TestCase):
    """Verify auth model consistency: new endpoints follow existing patterns."""

    @classmethod
    def setUpClass(cls):
        src = os.path.join(os.path.dirname(__file__), 'cloud_relay_v2.py')
        with open(src, 'r', encoding='utf-8') as f:
            cls.source = f.read()

    def _get_block(self, marker, next_marker=None):
        start = self.source.find(marker)
        if next_marker:
            end = self.source.find(next_marker, start)
        else:
            end = len(self.source)
        return self.source[start:end] if start != -1 else ""

    def test_write_endpoints_have_auth_check(self):
        """Write operations must call _check_admin."""
        write_endpoints = [
            "if path == '/api/v1/advisor/set_admin':",
            "if path == '/api/v1/advisor/del_admin':",
            "if path == '/api/v1/pin/set_group':",
            "if path == '/api/v1/group/add':",
            "if path == '/api/v1/group/del':",
            "if path == '/api/v1/visits/batch':",
            "if path == '/api/v1/visit/delete':",
            "if path == '/api/v1/visit/update':",
            "if path == '/api/v1/kick':",
        ]
        for ep in write_endpoints:
            idx = self.source.find(ep)
            if idx == -1:
                self.fail(f"Write endpoint not found: {ep}")
            # Search 200 chars after the endpoint declaration for auth check
            block = self.source[idx:idx + 400]
            self.assertIn("_check_admin", block,
                          f"Missing _check_admin in write endpoint: {ep}")

    def test_read_endpoints_consistent_with_existing_pattern(self):
        """Read endpoints (devices, device-history) follow same auth pattern as
        existing read endpoints (calls, visits, pins)."""
        read_candidates = [
            "if path == '/api/v1/devices':",
            "if path == '/api/v1/device-history':",
        ]
        existing_read = "if path == '/api/v1/calls':"

        # Get the existing read endpoint pattern
        idx_existing = self.source.find(existing_read)
        existing_has_auth = "_check_admin" in self.source[idx_existing:idx_existing + 100]

        for ep in read_candidates:
            idx = self.source.find(ep)
            block = self.source[idx:idx + 200] if idx != -1 else ""
            new_has_auth = "_check_admin" in block

            # They should be consistent
            self.assertEqual(
                existing_has_auth, new_has_auth,
                f"Auth pattern inconsistency: {ep} differs from /api/v1/calls"
            )

    def test_device_history_not_a_write_endpoint(self):
        """/api/v1/device-history is GET-only, should be treated as read."""
        idx = self.source.find("if path == '/api/v1/device-history':")
        block = self.source[idx:idx + 300]
        # Should NOT have destructive operations
        self.assertNotIn("DELETE", block)
        self.assertNotIn("INSERT", block)
        self.assertNotIn("UPDATE", block)


# ============================================================
# TEST 8: Dashboard HTML Validation
# ============================================================
class TestDashboardHTML(unittest.TestCase):
    """Validate dashboard.html structure and JS references."""

    @classmethod
    def setUpClass(cls):
        html_path = os.path.join(os.path.dirname(__file__), 'dashboard.html')
        with open(html_path, 'r', encoding='utf-8') as f:
            cls.html = f.read()

    # --- HTML structure ---
    def test_html_doctype(self):
        self.assertTrue(self.html.strip().startswith('<!DOCTYPE html>'))

    def test_html_tag_closed(self):
        self.assertIn('</html>', self.html)

    def test_body_tag_closed(self):
        self.assertIn('</body>', self.html)

    def test_head_tag_closed(self):
        self.assertIn('</head>', self.html)

    def test_no_unclosed_divs(self):
        """Rough check: opening and closing div counts should match."""
        # Remove template literal divs inside JS strings to avoid false positives
        js_free = re.sub(r'<script>.*?</script>', '', self.html, flags=re.DOTALL)
        opens = len(re.findall(r'<div\b', js_free, re.IGNORECASE))
        closes = len(re.findall(r'</div>', js_free, re.IGNORECASE))
        self.assertEqual(opens, closes,
                         f"Unbalanced <div> tags: {opens} open vs {closes} close")

    # --- Tab count ---
    def test_eight_tabs(self):
        """Dashboard should have exactly 8 tab pages."""
        pages = re.findall(r'class="page\b', self.html)
        self.assertEqual(len(pages), 8, f"Expected 8 tab pages, found {len(pages)}")

    def test_tab_names(self):
        """Verify expected tab page IDs exist."""
        expected_tabs = ['dashboard', 'phones', 'calls', 'visits',
                         'pins', 'admin-accounts', 'logs', 'settings']
        for tab in expected_tabs:
            self.assertIn(f'id="page-{tab}"', self.html,
                          f"Missing tab page: {tab}")

    # --- Chart.js dependency ---
    def test_chartjs_loaded(self):
        self.assertIn('chart.js', self.html.lower())

    # --- Login/Logout ---
    def test_login_functions_exist(self):
        self.assertIn('function doLogin(', self.html)
        self.assertIn('function doLogout(', self.html)
        self.assertIn('function getSessionToken(', self.html)

    def test_login_ui_exists(self):
        self.assertIn('id="login-overlay"', self.html)
        self.assertIn('id="login-btn"', self.html)
        self.assertIn('id="logout-btn"', self.html)

    # --- Batch import ---
    def test_import_functions_exist(self):
        self.assertIn('function showImportModal(', self.html)
        self.assertIn('function closeImportModal(', self.html)
        self.assertIn('function parseImportData(', self.html)
        self.assertIn('function submitImport(', self.html)

    def test_import_modal_exists(self):
        self.assertIn('id="import-modal"', self.html)

    # --- Filters ---
    def test_filter_elements_exist(self):
        self.assertIn('id="phone-status-filter"', self.html)
        self.assertIn('id="call-date-from"', self.html)
        self.assertIn('id="call-date-to"', self.html)
        self.assertIn('id="visit-filter-pin"', self.html)
        self.assertIn('id="visit-filter-source"', self.html)

    # --- Pagination ---
    def test_pagination_exists(self):
        self.assertIn('id="calls-pagination"', self.html)
        self.assertIn('callsOffset', self.html)

    # --- Export ---
    def test_export_functions_exist(self):
        self.assertIn('function exportCSV(', self.html)
        self.assertIn('function exportCallsCSV(', self.html)

    # --- New dashboard elements ---
    def test_new_stat_cards_exist(self):
        self.assertIn('id="stat-today-dials"', self.html)
        self.assertIn('id="stat-today-visits"', self.html)
        self.assertIn('id="stat-active-names"', self.html)

    # --- Phone management new fields ---
    def test_phone_table_new_columns(self):
        self.assertIn('当前登录人', self.html)
        self.assertIn('当前PIN', self.html)

    # ================================================================
    # JS Reference Checks (does every onclick/onchange function exist?)
    # ================================================================

    def _extract_js_functions(self):
        """Extract all function names defined in <script> blocks."""
        funcs = set()
        for m in re.finditer(r'function\s+(\w+)\s*\(', self.html):
            funcs.add(m.group(1))
        # Also catch var assignments of functions
        for m in re.finditer(r'(?:let|var|const)\s+(\w+)\s*=\s*(?:async\s+)?function\s*\(', self.html):
            funcs.add(m.group(1))
        return funcs

    def _extract_function_calls(self):
        """Extract function names called in onclick/onchange/event handlers."""
        calls = set()
        # onclick="funcName(...)"
        for m in re.finditer(r'on(?:click|change|input|blur|keydown)\s*=\s*"([^(]+)\(', self.html):
            calls.add(m.group(1).strip())
        # In JS code: funcName(...)
        for m in re.finditer(r'(?<!function\s)(?<!function\()\b(\w+)\s*\(', self.html):
            name = m.group(1)
            # Skip built-in JS functions and keywords
            if name not in ('if', 'for', 'while', 'switch', 'catch', 'return',
                            'document', 'console', 'window', 'Array', 'Object',
                            'String', 'Number', 'parseInt', 'parseFloat',
                            'JSON', 'Math', 'Date', 'setTimeout', 'setInterval',
                            'clearTimeout', 'clearInterval', 'fetch',
                            'encodeURIComponent', 'encodeURI', 'decodeURIComponent',
                            'decodeURI', 'alert', 'confirm', 'prompt',
                            'URL', 'Blob', 'FileReader', 'FormData',
                            'addEventListener', 'querySelector', 'querySelectorAll',
                            'getElementById', 'getElementsByClassName',
                            'getElementsByTagName', 'createElement',
                            'appendChild', 'removeChild', 'replaceChild',
                            'classList', 'setAttribute', 'getAttribute',
                            'localStorage', 'sessionStorage',
                            'location', 'history', 'navigator',
                            'isNaN', 'isFinite', 'escape', 'unescape',
                            'Error', 'TypeError', 'SyntaxError',
                            'new', 'import', 'export', 'default', 'from',
                            'then', 'catch', 'finally', 'async', 'await',
                            'true', 'false', 'null', 'undefined',
                            'map', 'filter', 'reduce', 'forEach', 'find',
                            'sort', 'slice', 'splice', 'join', 'split',
                            'push', 'pop', 'shift', 'unshift', 'indexOf',
                            'includes', 'replace', 'match', 'trim',
                            'toLowerCase', 'toUpperCase', 'toString',
                            'parse', 'stringify', 'keys', 'values', 'entries',
                            'all', 'race', 'resolve', 'reject',
                            'log', 'error', 'warn', 'info', 'dir',
                            'reload', 'assign', 'open', 'close',
                            'focus', 'blur', 'click', 'submit',
                            'preventDefault', 'stopPropagation',
                            'toFixed', 'toISOString', 'toLocaleString',
                            'toLocaleTimeString', 'getTime', 'setDate',
                            'getDate', 'now', 'floor', 'ceil', 'round',
                            'abs', 'max', 'min', 'random', 'pow', 'sqrt',
                            'charAt', 'charCodeAt', 'substr', 'substring',
                            'concat', 'every', 'some', 'fill',
                            'textContent', 'innerHTML', 'value', 'style',
                            'length', 'name', 'id', 'type', 'role',
                            'target', 'key', 'status', 'message',
                            'ok', 'pin', 'data', 'code', 'text',
                            'Object', 'Promise', 'RegExp', 'Symbol',
                            'Map', 'Set', 'WeakMap', 'WeakSet',
                            'Intl', 'Reflect', 'Proxy',
                            'require', 'module', 'exports', '__dirname',
                            'Buffer', 'process', 'global',
                            'requestAnimationFrame', 'cancelAnimationFrame',
                            'getComputedStyle', 'matchMedia',
                            'getContext', 'destroy', 'Chart',
                            'URLSearchParams', 'URLSearchParams',
                            'createObjectURL', 'revokeObjectURL',
                            'from', 'of', 'apply', 'call', 'bind',
                            'hasOwnProperty', 'isPrototypeOf',
                            'propertyIsEnumerable', 'toLocaleString',
                            'valueOf', 'constructor',
                            'select', 'insertBefore', 'nextSibling',
                            'previousSibling', 'parentNode', 'childNodes',
                            'firstChild', 'lastChild', 'remove',
                            'closest', 'contains', 'matches',
                            'getBoundingClientRect', 'scrollIntoView',
                            'scrollTo', 'scrollBy', 'scrollTop',
                            'scrollHeight', 'clientHeight', 'offsetHeight',
                            'getElementsByName', 'write',
                            'play', 'pause', 'load', 'canPlayType',
                            'add', 'remove', 'toggle', 'item',
                            'getItem', 'setItem', 'removeItem',
                            'clear', 'key', 'dispatchEvent',
                            'createEvent', 'initEvent',
                            'postMessage', 'atob', 'btoa',
                            'performance', 'crypto',
                            'request', 'response',
                        ):
                continue
            calls.add(name)
        return calls

    def test_all_onclick_functions_defined(self):
        """Every onclick/onchange handler function must be defined."""
        defined = self._extract_js_functions()
        # Also check functions defined with `async function`
        for m in re.finditer(r'async\s+function\s+(\w+)\s*\(', self.html):
            defined.add(m.group(1))

        # Extract onclick/onchange calls — only pure function calls like "funcName(...)"
        onclick_calls = set()
        # JS keywords that can appear before '(' in inline handlers
        js_keywords = {'if', 'else', 'for', 'while', 'switch', 'return', 'typeof',
                       'void', 'delete', 'new', 'this', 'true', 'false', 'null'}
        for m in re.finditer(r'on(?:click|change|input|blur|keydown)\s*=\s*"(\w+)\s*\(', self.html):
            name = m.group(1).strip()
            if name not in js_keywords:
                onclick_calls.add(name)

        missing = onclick_calls - defined
        self.assertEqual(len(missing), 0,
                         f"Undefined onclick handler(s): {missing}")


# ============================================================
# TEST 9: SQL injection / parameterization check
# ============================================================
class TestSQLInjectionSafety(unittest.TestCase):
    """Verify new queries use parameterized SQL (no f-string injection of user input)."""

    @classmethod
    def setUpClass(cls):
        src = os.path.join(os.path.dirname(__file__), 'cloud_relay_v2.py')
        with open(src, 'r', encoding='utf-8') as f:
            cls.source = f.read()

    def test_device_history_uses_placeholder(self):
        """device-history query must use ? placeholder, not f-string for device_id."""
        start = self.source.find("if path == '/api/v1/device-history':")
        end = self.source.find("if path == '/api/v1/calls':", start)
        block = self.source[start:end]

        # Must use parameterized query with (device_id,) tuple
        self.assertIn('(device_id,)', block,
                      "device_id must be passed as parameter, not interpolated")

    def test_devices_query_is_safe(self):
        """devices query reads from DB safely."""
        start = self.source.find("if path == '/api/v1/devices':")
        end = self.source.find("if path == '/api/v1/device-history':", start)
        block = self.source[start:end]

        # The SELECT * FROM phones doesn't take user input, but check
        # the pin_name_map query uses placeholders
        self.assertIn('placeholders', block,
                      "pin name lookup must use placeholders")

    def test_status_query_is_safe(self):
        start = self.source.find("if path == '/api/status':")
        end = self.source.find("if path == '/api/clients':", start)
        block = self.source[start:end]
        # today_str is programmatic (datetime.now()), safe to use as param
        self.assertIn('(today_str,)', block)


# ============================================================
# TEST 10: DB Schema consistency
# ============================================================
class TestDBSchemaConsistency(unittest.TestCase):
    """Ensure tables referenced in API match init_db schema."""

    @classmethod
    def setUpClass(cls):
        src = os.path.join(os.path.dirname(__file__), 'cloud_relay_v2.py')
        with open(src, 'r', encoding='utf-8') as f:
            cls.source = f.read()

    def test_call_records_raw_table_defined(self):
        """Table call_records_raw must exist in schema definition."""
        self.assertIn('call_records_raw', self.source)

    def test_phone_events_table_defined(self):
        """Table phone_events must exist in schema."""
        self.assertIn('phone_events', self.source)

    def test_phones_table_defined(self):
        self.assertIn('CREATE TABLE IF NOT EXISTS phones', self.source)

    def test_advisor_names_table_defined(self):
        self.assertIn('CREATE TABLE IF NOT EXISTS advisor_names', self.source)

    def test_visits_table_defined(self):
        self.assertIn('CREATE TABLE IF NOT EXISTS visits', self.source)

    def test_pin_groups_table_defined(self):
        self.assertIn('CREATE TABLE IF NOT EXISTS pin_groups', self.source)


# ============================================================
# TEST 11: HTML inline JS syntax check (basic)
# ============================================================
class TestJavaScriptBasicSyntax(unittest.TestCase):
    """Basic JS syntax validation in dashboard.html."""

    @classmethod
    def setUpClass(cls):
        html_path = os.path.join(os.path.dirname(__file__), 'dashboard.html')
        with open(html_path, 'r', encoding='utf-8') as f:
            cls.html = f.read()

    def _extract_scripts(self):
        return re.findall(r'<script>(.*?)</script>', self.html, re.DOTALL)

    def test_no_double_braces_in_js(self):
        """JS code should not have Python-style format braces unused."""
        # This checks for common copy-paste errors
        scripts = self._extract_scripts()
        for script in scripts:
            # Allow template literals with ${}
            # Check for stray {{ }} which are Python format artifacts
            stray = re.findall(r'(?<!\$)\{\{', script)
            self.assertEqual(len(stray), 0,
                             f"Potential Python-format artifact: {{ found in JS")

    def test_template_literals_balanced(self):
        """Template literal backticks should be balanced."""
        scripts = self._extract_scripts()
        for i, script in enumerate(scripts):
            backticks = script.count('`')
            self.assertEqual(backticks % 2, 0,
                             f"Unbalanced backticks in script block {i}")

    def test_no_document_write(self):
        """Should not use document.write (blocks rendering)."""
        scripts = self._extract_scripts()
        for i, script in enumerate(scripts):
            self.assertNotIn('document.write', script,
                             f"document.write found in script block {i}")

    def test_modern_js_patterns(self):
        """Verify modern JS patterns used (const/let, not var-only)."""
        scripts = self._extract_scripts()
        has_const = any('const ' in s for s in scripts)
        has_let = any('let ' in s for s in scripts)
        # At least one modern declaration should exist
        self.assertTrue(has_const or has_let,
                        "No const/let declarations found (modern JS expected)")


# ============================================================
# RUNNER
# ============================================================
if __name__ == '__main__':
    # Increase verbosity for CI
    unittest.main(verbosity=2)
