; MD Previewer installer (Inno Setup 6, per-user)
;
; Build:
;   1. cargo build --release
;   2. iscc installer\md-previewer.iss
;   -> output: dist\MdPreviewer-Setup-<ver>.exe

#define AppName        "MD Previewer"
#define AppVersion     "0.36.0"
#define AppPublisher   "Yuki Wakimoto"
#define AppExeName     "md-previewer.exe"
#define ProgID         "MdPreviewer.md"
#define ProgIDmdx      "MdPreviewer.mdx"

; ---- TikZJax (optional, downloaded at install time) ----------------------
; @rod2ik/tikzjax is GPL-3.0-or-later and bundles LPPL-licensed TeX packages
; plus compiled WASM binaries. It is deliberately NOT shipped inside this
; installer (see the Excludes on the assets\* entry below); instead the
; "tikz" task fetches it straight from the upstream npm registry, so this
; installer never conveys the GPL'd binaries itself.
; KEEP TikzjaxVersion IN SYNC WITH $TikzjaxVersion IN tools\fetch-libs.ps1.
; To bump: change the version, then re-run
;   curl -sL <TikzjaxUrl> | sha256sum
; and paste the digest into TikzjaxSha256.
#define TikzjaxVersion "1.5.0"
#define TikzjaxUrl     "https://registry.npmjs.org/@rod2ik/tikzjax/-/tikzjax-" + TikzjaxVersion + ".tgz"
#define TikzjaxSha256  "45d12756acaad80bfe8231cad4667e36cb3e908aa906cfce63496a70f074ab38"

[Setup]
; Keep this AppId stable across versions so upgrades replace the old install.
AppId={{892BC24C-95B0-43BB-8480-087C91AC6316}
AppName={#AppName}
AppVersion={#AppVersion}
AppPublisher={#AppPublisher}
VersionInfoVersion={#AppVersion}
DefaultDirName={localappdata}\Programs\MdPreviewer
DefaultGroupName={#AppName}
DisableProgramGroupPage=yes
PrivilegesRequired=lowest
PrivilegesRequiredOverridesAllowed=dialog
ArchitecturesInstallIn64BitMode=x64compatible
UninstallDisplayIcon={app}\{#AppExeName}
UninstallDisplayName={#AppName}
OutputDir=..\dist
OutputBaseFilename=MdPreviewer-Setup-{#AppVersion}
SetupIconFile=..\assets\icon.ico
Compression=lzma2/max
SolidCompression=yes
WizardStyle=modern
ShowLanguageDialog=no

[Languages]
Name: "japanese"; MessagesFile: "compiler:Languages\Japanese.isl"
Name: "english"; MessagesFile: "compiler:Default.isl"

[Files]
Source: "..\target\release\{#AppExeName}"; DestDir: "{app}"; Flags: ignoreversion
; NOTE: libs\tikzjax\* is excluded on purpose - it is GPL/LPPL and is fetched
; from upstream at install time by the "tikz" task instead (see [Code]).
; The exclusion also means an upgrade leaves an already-downloaded copy alone.
; libs\abcjs\soundfont\* is excluded for a different reason: it is 88 MP3s that
; compress to nothing, so shipping them would add their full ~2MB to this
; installer. The "abcsound" task downloads them at install time instead.
Source: "..\assets\*"; DestDir: "{app}\assets"; Excludes: "libs\tikzjax\*,libs\abcjs\soundfont\*"; Flags: ignoreversion recursesubdirs createallsubdirs
Source: "..\samples\*"; DestDir: "{app}\samples"; Flags: ignoreversion recursesubdirs createallsubdirs
Source: "..\README.md"; DestDir: "{app}"; Flags: ignoreversion
Source: "..\HISTORY.md"; DestDir: "{app}"; Flags: ignoreversion
Source: "..\LICENSE"; DestDir: "{app}"; Flags: ignoreversion
; NOTE: the Claude Code authoring skill is optional and OFF by default (task
;   "claudeskill"), and it lands OUTSIDE {app}, in the user's personal skills dir,
;   because that is where Claude Code looks for it.
;   samples\ is sourced from the repo's samples\ - NOT from the skill's committed
;   snapshot - so the shipped copy can never be stale.
;   package.ps1 and *.skill are dev artifacts: deliberately not enumerated here.
Source: "..\.claude\skills\md-previewer-author\SKILL.md"; DestDir: "{%USERPROFILE}\.claude\skills\md-previewer-author"; Tasks: claudeskill; Flags: ignoreversion
Source: "..\.claude\skills\md-previewer-author\references\*"; DestDir: "{%USERPROFILE}\.claude\skills\md-previewer-author\references"; Tasks: claudeskill; Flags: ignoreversion recursesubdirs createallsubdirs
Source: "..\samples\*"; DestDir: "{%USERPROFILE}\.claude\skills\md-previewer-author\samples"; Tasks: claudeskill; Flags: ignoreversion recursesubdirs createallsubdirs

[Icons]
Name: "{group}\{#AppName}"; Filename: "{app}\{#AppExeName}"; IconFilename: "{app}\{#AppExeName}"
Name: "{group}\使い方 (README)"; Filename: "{app}\{#AppExeName}"; Parameters: """{app}\README.md"""; IconFilename: "{app}\{#AppExeName}"; Comment: "機能一覧・ショートカット・カスタマイズ方法 / Feature guide, shortcuts and customization"
Name: "{group}\Sample Documents"; Filename: "{app}\samples"; IconFilename: "{app}\{#AppExeName}"; Comment: "機能デモ用 Markdown サンプル / Sample markdown files demonstrating features"
Name: "{group}\更新履歴 (Release Notes)"; Filename: "{app}\{#AppExeName}"; Parameters: """{app}\HISTORY.md"""; IconFilename: "{app}\{#AppExeName}"; Comment: "バージョンごとの更新内容 / What's new in each version"
Name: "{group}\Third-party Licenses"; Filename: "{app}\assets\THIRD_PARTY_LICENSES.txt"; Comment: "Open-source licenses for bundled libraries (marked / mermaid / KaTeX / highlight.js / Marp / CodeMirror, etc.)"
Name: "{group}\Uninstall {#AppName}"; Filename: "{uninstallexe}"
Name: "{userdesktop}\{#AppName}"; Filename: "{app}\{#AppExeName}"; IconFilename: "{app}\{#AppExeName}"; Tasks: desktopicon

[Tasks]
Name: "desktopicon"; Description: "デスクトップにショートカットを作成 / Create desktop shortcut"; Flags: unchecked
Name: "assoc_md";    Description: ".md / .markdown / .mdx を {#AppName} に関連付ける / Associate .md, .markdown & .mdx files"
Name: "ctx_folder";  Description: "フォルダ右クリックメニューに追加 / Add to folder context menu"
Name: "ctx_file";    Description: ".md / .mdx ファイル右クリックメニューに追加 / Add to .md & .mdx file context menu"
Name: "tikz";        Description: "TikZ・可換図式コンポーネントをダウンロード (約6MB, 要インターネット接続) / Download TikZ component (~6MB, needs internet)"
Name: "abcsound";    Description: "ABC 楽譜の再生用音源をダウンロード (約2MB, 要インターネット接続) / Download ABC playback sound bank (~2MB, needs internet)"
Name: "claudeskill"; Description: "Claude Code 用の文書作成スキルを導入 (%USERPROFILE%\.claude\skills\) / Install the Claude Code authoring skill"; Flags: unchecked

[Registry]
; ---- ProgID + DefaultIcon + open command ----
Root: HKCU; Subkey: "Software\Classes\{#ProgID}";                  ValueType: string; ValueData: "Markdown Document";                            Flags: uninsdeletekey; Tasks: assoc_md
Root: HKCU; Subkey: "Software\Classes\{#ProgID}\DefaultIcon";      ValueType: string; ValueData: "{app}\{#AppExeName},0";                       Tasks: assoc_md
Root: HKCU; Subkey: "Software\Classes\{#ProgID}\shell\open\command"; ValueType: string; ValueData: """{app}\{#AppExeName}"" ""%1""";              Tasks: assoc_md

; ---- .md / .markdown association ----
; Note: if the user has chosen another app via Windows "Default apps" settings,
; that choice overrides the HKCU default; OpenWithProgids still surfaces us in
; the right-click "Open with" submenu.
Root: HKCU; Subkey: "Software\Classes\.md";                       ValueType: string; ValueData: "{#ProgID}";                                    Flags: uninsdeletevalue; Tasks: assoc_md
Root: HKCU; Subkey: "Software\Classes\.md\OpenWithProgids";       ValueType: string; ValueName: "{#ProgID}"; ValueData: "";                     Flags: uninsdeletevalue; Tasks: assoc_md
Root: HKCU; Subkey: "Software\Classes\.markdown";                 ValueType: string; ValueData: "{#ProgID}";                                    Flags: uninsdeletevalue; Tasks: assoc_md
Root: HKCU; Subkey: "Software\Classes\.markdown\OpenWithProgids"; ValueType: string; ValueName: "{#ProgID}"; ValueData: "";                     Flags: uninsdeletevalue; Tasks: assoc_md

; ---- .mdx bundle ProgID + association (Markdown + bundled resources in a ZIP) ----
Root: HKCU; Subkey: "Software\Classes\{#ProgIDmdx}";                  ValueType: string; ValueData: "Markdown Bundle";                            Flags: uninsdeletekey; Tasks: assoc_md
Root: HKCU; Subkey: "Software\Classes\{#ProgIDmdx}\DefaultIcon";      ValueType: string; ValueData: "{app}\{#AppExeName},0";                       Tasks: assoc_md
Root: HKCU; Subkey: "Software\Classes\{#ProgIDmdx}\shell\open\command"; ValueType: string; ValueData: """{app}\{#AppExeName}"" ""%1""";            Tasks: assoc_md
Root: HKCU; Subkey: "Software\Classes\.mdx";                       ValueType: string; ValueData: "{#ProgIDmdx}";                                 Flags: uninsdeletevalue; Tasks: assoc_md
Root: HKCU; Subkey: "Software\Classes\.mdx\OpenWithProgids";       ValueType: string; ValueName: "{#ProgIDmdx}"; ValueData: "";                  Flags: uninsdeletevalue; Tasks: assoc_md

; ---- Folder context menu (folder itself + folder background) ----
Root: HKCU; Subkey: "Software\Classes\Directory\shell\MdPreviewer";                              ValueType: string; ValueData: "Open with MD Previewer";  Flags: uninsdeletekey; Tasks: ctx_folder
Root: HKCU; Subkey: "Software\Classes\Directory\shell\MdPreviewer";                              ValueType: string; ValueName: "Icon"; ValueData: """{app}\{#AppExeName}""";                Tasks: ctx_folder
Root: HKCU; Subkey: "Software\Classes\Directory\shell\MdPreviewer\command";                      ValueType: string; ValueData: """{app}\{#AppExeName}"" ""%1""";                              Tasks: ctx_folder
Root: HKCU; Subkey: "Software\Classes\Directory\Background\shell\MdPreviewer";                   ValueType: string; ValueData: "Open with MD Previewer";  Flags: uninsdeletekey; Tasks: ctx_folder
Root: HKCU; Subkey: "Software\Classes\Directory\Background\shell\MdPreviewer";                   ValueType: string; ValueName: "Icon"; ValueData: """{app}\{#AppExeName}""";                Tasks: ctx_folder
Root: HKCU; Subkey: "Software\Classes\Directory\Background\shell\MdPreviewer\command";           ValueType: string; ValueData: """{app}\{#AppExeName}"" ""%V""";                              Tasks: ctx_folder

; ---- .md / .markdown file context menu ----
Root: HKCU; Subkey: "Software\Classes\SystemFileAssociations\.md\shell\MdPreviewer";             ValueType: string; ValueData: "Open with MD Previewer";  Flags: uninsdeletekey; Tasks: ctx_file
Root: HKCU; Subkey: "Software\Classes\SystemFileAssociations\.md\shell\MdPreviewer";             ValueType: string; ValueName: "Icon"; ValueData: """{app}\{#AppExeName}""";                Tasks: ctx_file
Root: HKCU; Subkey: "Software\Classes\SystemFileAssociations\.md\shell\MdPreviewer\command";     ValueType: string; ValueData: """{app}\{#AppExeName}"" ""%1""";                              Tasks: ctx_file
Root: HKCU; Subkey: "Software\Classes\SystemFileAssociations\.markdown\shell\MdPreviewer";       ValueType: string; ValueData: "Open with MD Previewer";  Flags: uninsdeletekey; Tasks: ctx_file
Root: HKCU; Subkey: "Software\Classes\SystemFileAssociations\.markdown\shell\MdPreviewer";       ValueType: string; ValueName: "Icon"; ValueData: """{app}\{#AppExeName}""";                Tasks: ctx_file
Root: HKCU; Subkey: "Software\Classes\SystemFileAssociations\.markdown\shell\MdPreviewer\command"; ValueType: string; ValueData: """{app}\{#AppExeName}"" ""%1""";                            Tasks: ctx_file
Root: HKCU; Subkey: "Software\Classes\SystemFileAssociations\.mdx\shell\MdPreviewer";              ValueType: string; ValueData: "Open with MD Previewer";  Flags: uninsdeletekey; Tasks: ctx_file
Root: HKCU; Subkey: "Software\Classes\SystemFileAssociations\.mdx\shell\MdPreviewer";              ValueType: string; ValueName: "Icon"; ValueData: """{app}\{#AppExeName}""";                Tasks: ctx_file
Root: HKCU; Subkey: "Software\Classes\SystemFileAssociations\.mdx\shell\MdPreviewer\command";      ValueType: string; ValueData: """{app}\{#AppExeName}"" ""%1""";                              Tasks: ctx_file

[Run]
Filename: "{app}\{#AppExeName}"; Parameters: """{app}\HISTORY.md"""; Description: "{#AppName} を起動し更新内容を表示 / Launch {#AppName} (show what's new)"; Flags: nowait postinstall skipifsilent
Filename: "{app}\{#AppExeName}"; Parameters: """{app}\README.md"""; Description: "使い方 (README) を表示 / Show the user guide (README)"; Flags: nowait postinstall skipifsilent unchecked
Filename: "{win}\explorer.exe"; Parameters: """{app}"""; Description: "インストール先フォルダを開く / Open install folder"; Flags: nowait postinstall skipifsilent unchecked shellexec
Filename: "{app}\assets\THIRD_PARTY_LICENSES.txt"; Description: "サードパーティライセンスを表示 / View third-party licenses"; Flags: nowait postinstall skipifsilent unchecked shellexec

[UninstallDelete]
; The TikZ component is downloaded after install, so it is not recorded in the
; uninstall log and would otherwise be left behind.
Type: filesandordirs; Name: "{app}\assets\libs\tikzjax"
; Same for the ABC sound bank.
Type: filesandordirs; Name: "{app}\assets\libs\abcjs\soundfont"
; The optional Claude skill lands outside {app}. Its files ARE in the uninstall log,
; but samples\ has nested subdirectories, so remove that subtree wholesale and then
; drop the now-empty skill folder. Never touch {%USERPROFILE}\.claude\skills itself -
; other skills live there.
Type: filesandordirs; Name: "{%USERPROFILE}\.claude\skills\md-previewer-author\samples"
Type: dirifempty;     Name: "{%USERPROFILE}\.claude\skills\md-previewer-author\references"
Type: dirifempty;     Name: "{%USERPROFILE}\.claude\skills\md-previewer-author"

[Code]
// TikZ component acquisition.
//
// This mirrors the tikzjax block of tools\fetch-libs.ps1 (which does the same
// job for a dev checkout): fetch the upstream npm tarball, verify its SHA-256,
// and extract package/dist into the install's assets\libs\tikzjax\dist.
//
// Failure is always SOFT. An offline machine still gets a fully working
// previewer, minus the tikz / tikzcd fenced blocks - assets\index.html detects
// the missing engine and renders an actionable message in their place.
//
// NOTE: comments here are // rather than { } on purpose. Pascal brace comments
// do not nest, so an {app} / {tmp} constant named inside one ends it early.

const
  TikzMarkerRel = 'assets\libs\tikzjax\dist\tikzjax.js';
  TikzDestRel   = 'assets\libs\tikzjax';
  TikzTgzName   = 'rod2ik-tikzjax.tgz';

function TikzAlreadyInstalled(): Boolean;
begin
  Result := FileExists(ExpandConstant('{app}\' + TikzMarkerRel));
end;

function IsHttpUrl(const S: String): Boolean;
var
  L: String;
begin
  L := Lowercase(S);
  Result := (Pos('http://', L) = 1) or (Pos('https://', L) = 1);
end;

// Resolve where to fetch the tarball from. Priority, highest first:
//   1. /TIKZSRC=<url-or-path>   (plus optional /TIKZSHA256=<digest>)
//   2. assets\tikz-source.ini in the install dir - the same assets\* overlay
//      mechanism used to drop in update.json. INI rather
//      than JSON because Inno has GetIniString built in and Unicode-safe, and
//      has no JSON parser at all; update.json stays JSON because its consumer
//      is Rust/serde.
//   3. the compiled-in upstream npm registry URL.
procedure ResolveTikzSource(var Url, Sha: String);
var
  IniPath, V: String;
begin
  Url := '{#TikzjaxUrl}';
  Sha := '{#TikzjaxSha256}';

  IniPath := ExpandConstant('{app}\assets\tikz-source.ini');
  if FileExists(IniPath) then begin
    V := GetIniString('TikZ', 'Url', '', IniPath);
    if V <> '' then begin
      Url := V;
      Sha := GetIniString('TikZ', 'Sha256', '', IniPath);
      Log('tikz: source overridden by ' + IniPath);
    end;
  end;

  V := ExpandConstant('{param:TIKZSRC|}');
  if V <> '' then begin
    Url := V;
    Sha := ExpandConstant('{param:TIKZSHA256|}');
    Log('tikz: source overridden by /TIKZSRC');
  end;
end;

function OnTikzDownloadProgress(const Url, FileName: String; const Progress, ProgressMax: Int64): Boolean;
begin
  if (ProgressMax > 0) and not WizardSilent() then
    WizardForm.StatusLabel.Caption :=
      Format('TikZ コンポーネントを取得しています... %d%%', [(Progress * 100) div ProgressMax]);
  Result := True;
end;

function AcquireTikz(const Url, Sha: String; var Tgz: String): Boolean;
var
  Actual: String;
begin
  Result := False;
  Tgz := ExpandConstant('{tmp}\' + TikzTgzName);
  try
    if IsHttpUrl(Url) then begin
      // Raises on failure, and verifies the digest itself when Sha is set.
      DownloadTemporaryFile(Url, TikzTgzName, Sha, @OnTikzDownloadProgress);
    end else begin
      if not FileExists(Url) then begin
        Log('tikz: mirror file not found: ' + Url);
        Exit;
      end;
      if not CopyFile(Url, Tgz, False) then begin
        Log('tikz: could not copy from mirror: ' + Url);
        Exit;
      end;
      if Sha <> '' then begin
        Actual := GetSHA256OfFile(Tgz);
        if CompareText(Actual, Sha) <> 0 then begin
          Log('tikz: SHA-256 mismatch - expected ' + Sha + ', got ' + Actual);
          Exit;
        end;
      end;
    end;
    Result := True;
  except
    Log('tikz: acquire failed: ' + GetExceptionMessage);
  end;
end;

function ExtractTikz(const Tgz: String): Boolean;
var
  Tar, Dest, Params: String;
  ResultCode: Integer;
begin
  Result := False;

  // bsdtar ships with Windows 10 1803 and later.
  Tar := ExpandConstant('{sys}\tar.exe');
  if not FileExists(Tar) then begin
    Log('tikz: ' + Tar + ' not found (Windows 10 1803 or later required)');
    Exit;
  end;

  Dest := ExpandConstant('{app}\' + TikzDestRel);
  if not ForceDirectories(Dest) then begin
    Log('tikz: could not create ' + Dest);
    Exit;
  end;

  // --strip-components=1 rewrites package/dist/... to dist/..., landing the
  // tree exactly where fetch-libs.ps1 puts it with no extra move step. Naming
  // the member keeps package.json / README.md out of the install.
  Params := '-xzf "' + Tgz + '" -C "' + Dest + '" --strip-components=1 package/dist';
  if not Exec(Tar, Params, '', SW_HIDE, ewWaitUntilTerminated, ResultCode) then begin
    Log('tikz: could not run ' + Tar);
    Exit;
  end;
  if ResultCode <> 0 then begin
    Log('tikz: tar exited with code ' + IntToStr(ResultCode));
    Exit;
  end;

  // Also extract the tarball's own LICENSE (GPL-3.0) next to dist\.
  // The GPL asks that recipients be shown the terms, and package/LICENSE sits
  // outside package/dist so the extraction above cannot pick it up. Best
  // effort only: THIRD_PARTY_LICENSES.txt carries the same text regardless.
  Params := '-xzf "' + Tgz + '" -C "' + Dest + '" --strip-components=1 package/LICENSE';
  if not Exec(Tar, Params, '', SW_HIDE, ewWaitUntilTerminated, ResultCode) or (ResultCode <> 0) then
    Log('tikz: could not extract LICENSE (non-fatal)');

  // Trust the marker file, not tar's exit code alone.
  Result := TikzAlreadyInstalled();
end;

// ---- ABC playback sound bank --------------------------------------------
//
// abcjs' synth plays a tune by fetching one MP3 per sounding note from
//   <soundFontUrl><instrument>-mp3/<note>.mp3
// so "the sound bank" is a flat directory of 88 small files. Its default source
// is a CDN, which the offline-viewing rule forbids, hence a local copy.
//
// This mirrors the abc sound-bank block of tools\fetch-libs.ps1 (same URL, same
// note names, same order) - the .iss cannot read that script, so KEEP THEM IN
// SYNC. Only GM program 0 ships; every tune therefore sounds as piano.
//
// Failure is SOFT, like tikz: assets\index.html probes for C8.mp3 and, when it
// is missing, renders the playback bar disabled with an explanation.
const
  AbcSfDirRel  = 'assets\libs\abcjs\soundfont\acoustic_grand_piano-mp3';
  AbcSfBaseUrl = 'https://paulrosen.github.io/midi-js-soundfonts/FluidR3_GM/acoustic_grand_piano-mp3/';

// The 88 piano keys, A0..C8. midi-js-soundfonts names black keys with FLATS,
// which is also what abcjs asks for - sharps would 404 silently. C8 is LAST on
// purpose: it doubles as the "everything landed" marker and is the very file
// assets\index.html probes at runtime.
function AbcSfNotes(): TArrayOfString;
var
  Notes: TArrayOfString;
  Src, Tok: String;
  Oct, P, N: Integer;
begin
  SetArrayLength(Notes, 88);
  Notes[0] := 'A0';
  Notes[1] := 'Bb0';
  Notes[2] := 'B0';
  N := 3;
  for Oct := 1 to 7 do begin
    Src := 'C,Db,D,Eb,E,F,Gb,G,Ab,A,Bb,B,';
    repeat
      P := Pos(',', Src);
      Tok := Copy(Src, 1, P - 1);
      Src := Copy(Src, P + 1, Length(Src));
      Notes[N] := Tok + IntToStr(Oct);
      N := N + 1;
    until Src = '';
  end;
  Notes[N] := 'C8';
  Result := Notes;
end;

function AbcSfInstalled(): Boolean;
begin
  Result := FileExists(ExpandConstant('{app}\' + AbcSfDirRel + '\C8.mp3'));
end;

function OnAbcSfDownloadProgress(const Url, FileName: String; const Progress, ProgressMax: Int64): Boolean;
begin
  Result := True;
end;

function AcquireAbcSoundfont(): Boolean;
var
  Notes: TArrayOfString;
  Dest, Tmp, Note: String;
  I, Total, Got: Integer;
begin
  Result := False;
  Dest := ExpandConstant('{app}\' + AbcSfDirRel);
  if not ForceDirectories(Dest) then begin
    Log('abcsound: could not create ' + Dest);
    Exit;
  end;

  Notes := AbcSfNotes();
  Total := GetArrayLength(Notes);
  Got := 0;
  for I := 0 to Total - 1 do begin
    Note := Notes[I];
    if FileExists(Dest + '\' + Note + '.mp3') then begin
      Got := Got + 1;
      Continue;
    end;
    if not WizardSilent() then
      WizardForm.StatusLabel.Caption :=
        Format('ABC 再生用音源を取得しています... %d/%d', [I + 1, Total]);
    // Per note rather than per batch: one unreachable file costs that note's
    // silence, not the whole bank.
    try
      DownloadTemporaryFile(AbcSfBaseUrl + Note + '.mp3', 'abcsf.mp3', '', @OnAbcSfDownloadProgress);
      Tmp := ExpandConstant('{tmp}\abcsf.mp3');
      if CopyFile(Tmp, Dest + '\' + Note + '.mp3', False) then
        Got := Got + 1
      else
        Log('abcsound: could not place ' + Note);
      DeleteFile(Tmp);
    except
      Log('abcsound: ' + Note + ' failed: ' + GetExceptionMessage);
    end;
  end;

  Log(Format('abcsound: %d/%d notes present', [Got, Total]));
  Result := AbcSfInstalled();
end;

procedure InstallAbcSoundfont();
begin
  if not WizardIsTaskSelected('abcsound') then begin
    Log('abcsound: task not selected, skipping');
    Exit;
  end;

  // An upgrade keeps whatever is already there - the Excludes on the assets\*
  // entry means [Files] never touched it.
  if AbcSfInstalled() then begin
    Log('abcsound: already present, skipping download');
    Exit;
  end;

  if AcquireAbcSoundfont() then
    Log('abcsound: installed into ' + ExpandConstant('{app}\' + AbcSfDirRel))
  else
    SuppressibleMsgBox(
      'ABC 楽譜の再生用音源を取得できませんでした。' + #13#10 +
      '楽譜の表示を含め、再生以外の機能はすべて正常に動作します。' + #13#10#13#10 +
      'あとからインストーラーを再実行すると再試行できます。',
      mbInformation, MB_OK, IDOK);
end;

procedure InstallTikz();
var
  Url, Sha, Tgz: String;
  Ok: Boolean;
begin
  if not WizardIsTaskSelected('tikz') then begin
    Log('tikz: task not selected, skipping');
    Exit;
  end;

  // An upgrade over an existing install keeps whatever is already there: the
  // Excludes on the assets\* entry means [Files] never touched it.
  if TikzAlreadyInstalled() then begin
    Log('tikz: already present, skipping download');
    Exit;
  end;

  ResolveTikzSource(Url, Sha);
  Log('tikz: acquiring from ' + Url);
  if not WizardSilent() then
    WizardForm.StatusLabel.Caption := 'TikZ コンポーネントを取得しています...';

  // Spelled out rather than "A and B" so the evaluation order is unambiguous.
  Ok := AcquireTikz(Url, Sha, Tgz);
  if Ok then
    Ok := ExtractTikz(Tgz);

  if Ok then
    Log('tikz: installed into ' + ExpandConstant('{app}\' + TikzDestRel))
  else
    // SuppressibleMsgBox returns the default answer without showing anything
    // in silent mode, which is exactly what the auto-updater path needs.
    SuppressibleMsgBox(
      'TikZ・可換図式コンポーネントを取得できませんでした。' + #13#10 +
      'TikZ 以外の機能はすべて正常に動作します。' + #13#10#13#10 +
      'あとからインストーラーを再実行すると再試行できます。',
      mbInformation, MB_OK, IDOK);

  if Tgz <> '' then
    DeleteFile(Tgz);
end;

// Both optional components are fetched after the files are in place. Each one
// reports its own soft failure, so a machine that is offline for one is still
// offered the other.
procedure CurStepChanged(CurStep: TSetupStep);
begin
  if CurStep <> ssPostInstall then
    Exit;
  InstallTikz();
  InstallAbcSoundfont();
end;
