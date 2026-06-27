'use strict';
/**
 * 防火墙规则模块
 * 
 * 用法:
 *   const firewall = require('./modules/firewall');
 *   firewall.tryAddFirewallRule(PORT, DISCOVERY_PORT, fileLog);
 */

const { exec } = require('child_process');

let firewallWarning = false;

function tryAddFirewallRule(PORT, DISCOVERY_PORT, fileLog) {
  exec(
    'netsh advfirewall firewall add rule name="AutoDial" dir=in action=allow protocol=TCP localport=' + PORT + ' profile=any description=AutoDial一键拨号 2>nul & ' +
    'netsh advfirewall firewall add rule name="AutoDial UDP" dir=in action=allow protocol=UDP localport=' + DISCOVERY_PORT + ' profile=any description=AutoDial一键拨号 2>nul',
    (err) => {
      if (err) {
        console.log('[防火墙] 自动添加失败（需要管理员权限）');
        firewallWarning = true;
      } else {
        console.log('[防火墙] 入站规则已添加');
      }
    }
  );
}

function hasFirewallWarning() {
  return firewallWarning;
}

module.exports = {
  tryAddFirewallRule,
  hasFirewallWarning
};
