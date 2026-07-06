// electron/field - Windows hotspot / adapter / firewall helpers (hotspot.py + gui.py §8).
//
// The Python app drives the Windows Mobile Hotspot via WinRT
// (NetworkOperatorTetheringManager) and uses netsh / PowerShell for
// adapters+firewall. This TS port spawns the identical Windows commands
// (WinRT is reachable from PowerShell). Every command string below is a
// verbatim transcription of the reference invocations.
//
// SAFETY: functions in the MUTATIONS section start/stop the hotspot, reset
// adapters, remove Hyper-V switches, or open firewall ports. They are
// implemented for the UI to call on an explicit user action - they are NEVER
// invoked by tests or the loopback proof. Read-only enumerations are also not
// called under test.

import { spawn } from 'node:child_process';
import * as os from 'node:os';
import * as path from 'node:path';
import * as fs from 'node:fs';

const CREATE_NO_WINDOW = 0x08000000;

/** Spawn a process, capture stdout+stderr, resolve the trimmed combined text.
 *  `env` (merged over the parent env) is how SECRETS (hotspot passphrase) reach
 *  PowerShell WITHOUT string-interpolating them into a script - the child reads
 *  them from its environment, so nothing sensitive is ever placed on a command
 *  line or in a shell-parsed literal. */
function run(
  cmd: string,
  args: string[],
  timeoutMs = 10000,
  encoding: BufferEncoding = 'utf-8',
  env?: NodeJS.ProcessEnv,
): Promise<string> {
  return new Promise((resolve) => {
    let out = '';
    let done = false;
    const finish = (): void => {
      if (done) return;
      done = true;
      resolve(out.trim());
    };
    let child;
    try {
      child = spawn(cmd, args, { windowsHide: true, env: env ? { ...process.env, ...env } : process.env });
    } catch {
      resolve('');
      return;
    }
    const timer = setTimeout(() => {
      try {
        child.kill();
      } catch {
        /* ignore */
      }
      finish();
    }, timeoutMs);
    child.stdout?.on('data', (d: Buffer) => (out += d.toString(encoding)));
    child.stderr?.on('data', (d: Buffer) => (out += d.toString(encoding)));
    child.on('close', () => {
      clearTimeout(timer);
      finish();
    });
    child.on('error', () => {
      clearTimeout(timer);
      finish();
    });
  });
}

/** PowerShell exec primitive (_ps): non-interactive, no profile, no window. */
export function ps(command: string, timeoutMs = 10000, env?: NodeJS.ProcessEnv): Promise<string> {
  return run('powershell', ['-NoProfile', '-NonInteractive', '-Command', command], timeoutMs, 'utf-8', env);
}

/** PowerShell single-quoted string literal - escapes embedded single quotes so an
 *  OS-enumerated name (adapter / vSwitch) can never break out of, or inject into,
 *  an elevated script. Use for any name interpolated into a mutation script. */
function psq(s: string): string {
  return `'${String(s).replace(/'/g, "''")}'`;
}

// -- §8f WiFi adapter enumeration ---------------------------------------------

export interface WifiAdapter {
  label: string;
  name: string;
  status: string;
}

const LIST_WIFI_PS =
  "Get-NetAdapter | Where-Object { ($_.InterfaceDescription -match 'Wi-Fi|Wireless|802.11|WLAN|WiFi' -or " +
  "$_.Name -match 'Wi-Fi|WiFi|WLAN|Wireless') -and $_.Name -notlike 'vEthernet*' } | " +
  'Select-Object Name, InterfaceDescription, Status | ConvertTo-Json';

export async function listWifiAdapters(): Promise<WifiAdapter[]> {
  const raw = await ps(LIST_WIFI_PS);
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return [];
  }
  const arr = Array.isArray(parsed) ? parsed : [parsed];
  return arr
    .filter((x): x is { Name: string; InterfaceDescription: string; Status: string } => !!x)
    .map((a) => ({
      label: `${a.Name}  -  ${a.InterfaceDescription}  [${a.Status}]`,
      name: a.Name,
      status: String(a.Status),
    }));
}

/** has_wifi(): true if any WiFi adapter is 'up' or 'disconnected'. */
export async function hasWifi(): Promise<{ ok: boolean; message: string }> {
  const adapters = await listWifiAdapters();
  for (const a of adapters) {
    const s = a.status.toLowerCase();
    if (s.includes('up') || s.includes('disconnected')) return { ok: true, message: '' };
  }
  return { ok: false, message: 'No usable WiFi adapter (adapter disabled?)' };
}

// -- §8i / §8k host IP + gateway -----------------------------------------------

export async function getHostIp(): Promise<string> {
  const ip = await ps(
    "Get-NetIPAddress -AddressFamily IPv4 | Where-Object { $_.IPAddress -like '192.168.137.*' } | Select-Object -First 1 -ExpandProperty IPAddress",
  );
  return ip || '192.168.137.1';
}

export async function getGatewayIp(): Promise<string> {
  return ps("(Get-NetRoute -DestinationPrefix '0.0.0.0/0' | Sort-Object RouteMetric | Select-Object -First 1).NextHop");
}

// -- §8j general adapter list for sync (ipconfig /all, OEM encoding) -----------

export interface NetworkAdapter {
  label: string;
  ip: string;
  broadcast: string;
}

/** Directed broadcast for ip/mask (IPv4Network(...).broadcast_address). */
function directedBroadcast(ip: string, mask: string): string {
  const ipp = ip.split('.').map(Number);
  const mp = mask.split('.').map(Number);
  if (ipp.length !== 4 || mp.length !== 4 || [...ipp, ...mp].some((n) => Number.isNaN(n))) return '';
  return ipp.map((o, i) => (o & mp[i]) | (~mp[i] & 0xff)).join('.');
}

export async function listNetworkAdapters(): Promise<NetworkAdapter[]> {
  // ipconfig avoids a PowerShell hang while the hotspot vNIC is configuring.
  const text = await run('ipconfig', ['/all'], 8000, 'latin1');
  const lines = text.split(/\r?\n/);
  const out: NetworkAdapter[] = [];
  let alias = '';
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const header = line.match(/^[^\s].*adapter\s+(.+?):\s*$/i);
    if (header) {
      alias = header[1].trim();
      continue;
    }
    const ipm = line.match(/IPv4 Address[.\s]*:\s*([0-9.]+)/i);
    if (ipm) {
      const ip = ipm[1];
      if (ip.startsWith('127.') || ip.startsWith('169.254.')) continue;
      let mask = '';
      for (let j = i + 1; j < Math.min(i + 3, lines.length); j++) {
        const mm = lines[j].match(/Subnet Mask[.\s]*:\s*([0-9.]+)/i);
        if (mm) {
          mask = mm[1];
          break;
        }
      }
      const broadcast = mask ? directedBroadcast(ip, mask) : '';
      out.push({ label: `${alias}  -  ${ip}`, ip, broadcast });
    }
  }
  return out;
}

// -- §8g Hyper-V conflict detection --------------------------------------------

export async function checkHyperVConflict(): Promise<string | null> {
  const veth = await ps(
    "Get-NetAdapter | Where-Object { $_.Name -like 'vEthernet*' -and ($_.Name -match 'WiFi|Wi-Fi|WIFI|Wireless|WLAN') } | Select-Object -First 1 -ExpandProperty Name",
  );
  if (veth) return veth;
  const vswitch = await ps(
    "(Get-VMSwitch -SwitchType External 2>$null | Where-Object { $_.NetAdapterInterfaceDescription -match 'Wi-Fi|Wireless|802.11|WLAN' } | Select-Object -First 1).Name",
  );
  return vswitch || null;
}

// -- §8l subnet peer scan (TCP connect to X.X.X.1..254 on 47824) ---------------

export async function scanForWifiSync(selfIp: string, port = 47824, timeoutMs = 1000): Promise<string[]> {
  const net = await import('node:net');
  const base = selfIp.slice(0, selfIp.lastIndexOf('.'));
  const found: string[] = [];
  const probes: Promise<void>[] = [];
  for (let h = 1; h <= 254; h++) {
    const ip = `${base}.${h}`;
    if (ip === selfIp) continue;
    probes.push(
      new Promise<void>((resolve) => {
        const sock = net.createConnection({ host: ip, port });
        const done = (hit: boolean): void => {
          if (hit) found.push(ip);
          sock.destroy();
          resolve();
        };
        sock.setTimeout(timeoutMs, () => done(false));
        sock.on('connect', () => done(true));
        sock.on('error', () => done(false));
      }),
    );
  }
  await Promise.all(probes);
  return found.sort((a, b) => Number(a.split('.')[3]) - Number(b.split('.')[3]));
}

// ++++++++++++++++++++++++++++++++++++++++++++++++++++++++++++++++++++++++++++++
//  MUTATIONS - implemented per spec; NEVER invoked by tests/loopback. Gate each
//  behind an explicit user action in the UI layer.
// ++++++++++++++++++++++++++++++++++++++++++++++++++++++++++++++++++++++++++++++

/** §8b elevated script runner: writes a transcript-wrapped .ps1 and self-elevates
 *  via Start-Process -Verb RunAs (UAC prompt), returning the transcript body. */
export async function runScriptElevated(script: string): Promise<string> {
  const tmpDir = os.tmpdir();
  const psPath = path.join(tmpDir, 'wifisync_hs_elev.ps1');
  const outPath = path.join(tmpDir, 'wifisync_hs_out.txt');
  const body =
    `Start-Transcript -Path "${outPath}" -Force | Out-Null\n` + script + `\nStop-Transcript | Out-Null\n`;
  // utf-8 with BOM.
  fs.writeFileSync(psPath, '﻿' + body, { encoding: 'utf-8' });
  try {
    fs.writeFileSync(outPath, '', 'utf-8');
  } catch {
    /* ignore */
  }
  const launcher =
    `Start-Process powershell -ArgumentList '-NoProfile -ExecutionPolicy Bypass -File "${psPath}"' ` +
    `-Verb RunAs -Wait -WindowStyle Hidden`;
  await run('powershell', ['-NoProfile', '-Command', launcher], 120000);
  let transcript = '';
  try {
    transcript = fs.readFileSync(outPath, 'latin1');
  } catch {
    return '';
  }
  const lines = transcript.split(/\r?\n/);
  const startIdx = lines.findIndex((l) => /\*{4}.*started.*\*{4}/i.test(l));
  const endIdx = lines.findIndex((l) => /\*{4}.*ended.*\*{4}/i.test(l));
  if (startIdx >= 0 && endIdx > startIdx) return lines.slice(startIdx + 1, endIdx).join('\n').trim();
  return transcript.trim();
}

/** §8h reset the WiFi adapter + ICS service (elevated). Success iff "STATUS:0". */
export async function resetAdapter(wifiName: string): Promise<{ ok: boolean; output: string }> {
  const script =
    `Disable-NetAdapter -Name ${psq(wifiName)} -Confirm:$false -ErrorAction SilentlyContinue\n` +
    `Start-Sleep -Seconds 2\n` +
    `Enable-NetAdapter  -Name ${psq(wifiName)} -Confirm:$false -ErrorAction SilentlyContinue\n` +
    `Start-Sleep -Seconds 3\n` +
    `Stop-Service  -Name "icssvc" -Force -ErrorAction SilentlyContinue\n` +
    `Start-Sleep -Milliseconds 500\n` +
    `Start-Service -Name "icssvc" -ErrorAction SilentlyContinue\n` +
    `Start-Sleep -Seconds 1\n` +
    `Write-Output "STATUS:0 - Adapter and service reset complete"`;
  const output = await runScriptElevated(script);
  return { ok: output.includes('STATUS:0'), output };
}

/** §8g fix: remove the Hyper-V WiFi external switch (elevated). */
export async function removeHyperVWifiSwitch(switchName: string): Promise<{ ok: boolean; output: string }> {
  const script = `Remove-VMSwitch -Name ${psq(switchName)} -Force -ErrorAction Stop\nWrite-Output 'REMOVED:OK'`;
  const output = await runScriptElevated(script);
  return { ok: output.includes('REMOVED:OK'), output };
}

/** §8m open the three firewall rules (private profile only), each elevated. */
export async function openFirewallPorts(): Promise<void> {
  const rules = [
    'netsh advfirewall firewall add rule name="WifiSync UDP"    protocol=UDP dir=in  localport=47823 action=allow profile=private',
    'netsh advfirewall firewall add rule name="WifiSync TCP in" protocol=TCP dir=in  localport=47824 action=allow profile=private',
    'netsh advfirewall firewall add rule name="WifiSync TCP out" protocol=TCP dir=out localport=47824 action=allow profile=private',
  ];
  for (const rule of rules) {
    const launcher = `Start-Process cmd -ArgumentList '/c ${rule}' -Verb RunAs -Wait`;
    await run('powershell', ['-NoProfile', '-Command', launcher], 30000);
  }
}

/** §8c/§8d/§8e hotspot control via PowerShell WinRT. Implemented for the UI;
 *  never called by tests. `password` must be >= 8 chars. */
export const HOTSPOT_WINRT_PRELUDE =
  '[Windows.Networking.Connectivity.NetworkInformation,Windows.Networking.Connectivity,ContentType=WindowsRuntime] | Out-Null;' +
  '[Windows.Networking.NetworkOperators.NetworkOperatorTetheringManager,Windows.Networking.NetworkOperators,ContentType=WindowsRuntime] | Out-Null;';

export function tetheringCapabilityMessage(code: number): string {
  const map: Record<number, string> = {
    0: 'OK',
    1: 'Disabled by Group Policy',
    2: 'hardware (adapter has no AP mode)',
    3: 'Disabled by operator',
    4: 'Disabled by Windows edition (SKU)',
    5: 'Required app not installed',
    6: 'unknown',
    7: 'Disabled by system capability',
  };
  return map[code] ?? `unknown capability code ${code}`;
}

// -- WinRT async-await plumbing (shared PowerShell prelude) --------------------
// Awaiting a WinRT IAsyncOperation / IAsyncAction from PowerShell needs the
// AsTask extension off System.Runtime.WindowsRuntime. This prelude defines two
// helpers (Await for IAsyncOperation<T>, AwaitAction for IAsyncAction) plus a
// Find-WifiProfile that mirrors _find_wifi_profile (§8c step 3). SSID/passphrase
// are read from $env (never string-interpolated) - see run(env).
const WINRT_PRELUDE = `
$ErrorActionPreference = 'Stop'
${HOTSPOT_WINRT_PRELUDE.replace(/;/g, "\n")}
[void][Windows.Networking.Connectivity.NetworkAdapter,Windows.Networking.Connectivity,ContentType=WindowsRuntime]
Add-Type -AssemblyName System.Runtime.WindowsRuntime
$rtMethods = [System.WindowsRuntimeSystemExtensions].GetMethods()
$asTaskOp = ($rtMethods | Where-Object { $_.Name -eq 'AsTask' -and $_.GetParameters().Count -eq 1 -and $_.GetParameters()[0].ParameterType.Name -eq 'IAsyncOperation\`1' })[0]
$asTaskAct = ($rtMethods | Where-Object { $_.Name -eq 'AsTask' -and $_.GetParameters().Count -eq 1 -and $_.GetParameters()[0].ParameterType.Name -eq 'IAsyncAction' })[0]
function Await($op, $t) { $m = $asTaskOp.MakeGenericMethod($t); $task = $m.Invoke($null, @($op)); $task.Wait(-1) | Out-Null; return $task.Result }
function AwaitAction($op) { $task = $asTaskAct.Invoke($null, @($op)); $task.Wait(-1) | Out-Null }
function Find-WifiProfile($adapterGuid) {
  $profiles = [Windows.Networking.Connectivity.NetworkInformation]::GetConnectionProfiles()
  $wireless = @()
  foreach ($p in $profiles) {
    $a = $p.NetworkAdapter
    if ($a -ne $null -and $a.NetworkAdapterKind -eq 2) { $wireless += $p }
  }
  if ($adapterGuid) {
    foreach ($p in $wireless) {
      $g = $p.NetworkAdapter.NetworkAdapterId.ToString().ToLower().Trim('{','}')
      if ($g -eq $adapterGuid) { return $p }
    }
  }
  if ($wireless.Count -gt 0) { return $wireless[0] }
  return [Windows.Networking.Connectivity.NetworkInformation]::GetInternetConnectionProfile()
}
`;

export interface HotspotStartResult {
  ok: boolean;
  error?: string;
}

/** §8c hotspot start via WinRT (NetworkOperatorTetheringManager). SSID and the
 *  passphrase are passed through the child's ENVIRONMENT (WFS_SSID / WFS_PASS),
 *  never interpolated into the script. Password must be >= 8 chars. `adapterName`
 *  (optional) resolves the preferred WiFi profile via its InterfaceGuid. NEVER
 *  called by tests - gated behind an explicit user action. */
export async function hotspotStart(ssid: string, password: string, adapterName?: string): Promise<HotspotStartResult> {
  if (!password || password.length < 8) return { ok: false, error: 'Password must be at least 8 characters.' };
  const wifi = await hasWifi();
  if (!wifi.ok) return { ok: false, error: wifi.message };
  const conflict = await checkHyperVConflict();
  if (conflict) return { ok: false, error: `HYPERV_CONFLICT:${conflict}` };

  // Resolve the adapter GUID (lowercased, braces stripped) if a name was given.
  let adapterGuid = '';
  if (adapterName) {
    const g = await ps(`(Get-NetAdapter -Name "${adapterName.replace(/"/g, '')}").InterfaceGuid`);
    adapterGuid = g.toLowerCase().replace(/[{}]/g, '').trim();
  }

  const script = `${WINRT_PRELUDE}
try {
  $profile = Find-WifiProfile '${adapterGuid}'
  if ($profile -eq $null) { Write-Output 'ERR:No WiFi connection profile found'; exit 0 }
  $cap = [Windows.Networking.NetworkOperators.NetworkOperatorTetheringManager]::GetTetheringCapabilityFromConnectionProfile($profile)
  if ([int]$cap -ne 0) { Write-Output ('CAP:' + [int]$cap); exit 0 }
  $mgr = [Windows.Networking.NetworkOperators.NetworkOperatorTetheringManager]::CreateFromConnectionProfile($profile)
  $cfg = $mgr.GetCurrentAccessPointConfiguration()
  $cfg.Ssid = $env:WFS_SSID
  $cfg.Passphrase = $env:WFS_PASS
  AwaitAction ($mgr.ConfigureAccessPointAsync($cfg))
  $res = Await ($mgr.StartTetheringAsync()) ([Windows.Networking.NetworkOperators.NetworkOperatorTetheringOperationResult])
  if ([int]$res.Status -ne 0) { Write-Output ('START:' + [int]$res.Status); exit 0 }
  for ($i = 0; $i -lt 6; $i++) {
    if ([int]$mgr.TetheringOperationalState -eq 1) { Write-Output 'OK'; exit 0 }
    Start-Sleep -Seconds 1
  }
  Write-Output 'TIMEOUT'
} catch { Write-Output ('ERR:' + $_.Exception.Message) }`;

  const out = await ps(script, 30000, { WFS_SSID: ssid, WFS_PASS: password });
  const line = out.split(/\r?\n/).map((l) => l.trim()).filter(Boolean).pop() ?? '';
  if (line === 'OK') return { ok: true };
  if (line.startsWith('CAP:')) return { ok: false, error: tetheringCapabilityMessage(Number(line.slice(4))) };
  if (line.startsWith('START:')) return { ok: false, error: `StartTethering failed (status ${line.slice(6)})` };
  if (line === 'TIMEOUT') return { ok: false, error: 'Hotspot did not reach On within 6 s.' };
  if (line.startsWith('ERR:')) return { ok: false, error: line.slice(4) || 'Unknown hotspot error' };
  return { ok: false, error: out || 'Hotspot start produced no output' };
}

/** §8d hotspot stop via WinRT. NEVER called by tests. */
export async function hotspotStop(): Promise<HotspotStartResult> {
  const script = `${WINRT_PRELUDE}
try {
  # Resolve the WiFi profile the same way Start does (Find-WifiProfile, which itself
  # falls back to the internet profile), so Stop works even with NO upstream internet
  # - the no-router hotspot case, where GetInternetConnectionProfile() is null and Stop
  # would otherwise silently no-op. (The Python original had this same limitation.)
  $profile = Find-WifiProfile ''
  if ($profile -eq $null) { Write-Output 'ERR:No WiFi or internet connection profile found'; exit 0 }
  $mgr = [Windows.Networking.NetworkOperators.NetworkOperatorTetheringManager]::CreateFromConnectionProfile($profile)
  # StopTetheringAsync returns IAsyncOperation<NetworkOperatorTetheringOperationResult> (NOT IAsyncAction) - await it like StartTetheringAsync.
  $res = Await ($mgr.StopTetheringAsync()) ([Windows.Networking.NetworkOperators.NetworkOperatorTetheringOperationResult])
  if ([int]$res.Status -ne 0) { Write-Output ('STOP:' + [int]$res.Status); exit 0 }
  Write-Output 'OK'
} catch { Write-Output ('ERR:' + $_.Exception.Message) }`;
  const out = await ps(script, 20000);
  const line = out.split(/\r?\n/).map((l) => l.trim()).filter(Boolean).pop() ?? '';
  if (line === 'OK') return { ok: true };
  if (line.startsWith('STOP:')) return { ok: false, error: `StopTethering failed (status ${line.slice(5)})` };
  return { ok: false, error: line.startsWith('ERR:') ? line.slice(4) : out || 'Hotspot stop failed' };
}

export interface HotspotStatus {
  running: boolean;
  ssid: string;
  clients: number;
}

/** §8e hotspot status via WinRT - READ-ONLY (no mutation), so it is safe to
 *  invoke from the live-drive smoke test to prove IPC wiring. */
export async function hotspotStatus(): Promise<HotspotStatus> {
  const script = `${WINRT_PRELUDE}
try {
  $profile = [Windows.Networking.Connectivity.NetworkInformation]::GetInternetConnectionProfile()
  if ($profile -eq $null) { Write-Output '{"running":false,"ssid":"","clients":0}'; exit 0 }
  $mgr = [Windows.Networking.NetworkOperators.NetworkOperatorTetheringManager]::CreateFromConnectionProfile($profile)
  $running = if ([int]$mgr.TetheringOperationalState -eq 1) { 'true' } else { 'false' }
  $cfg = $mgr.GetCurrentAccessPointConfiguration()
  $ssid = ($cfg.Ssid -replace '"','')
  $clients = [int]$mgr.ClientCount
  Write-Output ('{"running":' + $running + ',"ssid":"' + $ssid + '","clients":' + $clients + '}')
} catch { Write-Output '{"running":false,"ssid":"","clients":0}' }`;
  const out = await ps(script, 15000);
  const jsonLine = out.split(/\r?\n/).map((l) => l.trim()).reverse().find((l) => l.startsWith('{'));
  try {
    const p = JSON.parse(jsonLine ?? '{}');
    return { running: !!p.running, ssid: String(p.ssid ?? ''), clients: Number(p.clients ?? 0) };
  } catch {
    return { running: false, ssid: '', clients: 0 };
  }
}
