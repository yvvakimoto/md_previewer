; MD Previewer installer (Inno Setup 6, per-user)
;
; Build:
;   1. cargo build --release
;   2. iscc installer\md-previewer.iss
;   -> output: dist\MdPreviewer-Setup-<ver>.exe

#define AppName        "MD Previewer"
#define AppVersion     "1.0.1"
#define AppPublisher   "Yuki Wakimoto"
#define AppExeName     "md-previewer.exe"
#define ProgID         "MdPreviewer.md"

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
Source: "..\assets\*"; DestDir: "{app}\assets"; Flags: ignoreversion recursesubdirs createallsubdirs
Source: "..\samples\*"; DestDir: "{app}\samples"; Flags: ignoreversion recursesubdirs createallsubdirs

[Icons]
Name: "{group}\{#AppName}"; Filename: "{app}\{#AppExeName}"; IconFilename: "{app}\{#AppExeName}"
Name: "{group}\Sample Documents"; Filename: "{app}\samples"; IconFilename: "{app}\{#AppExeName}"; Comment: "機能デモ用 Markdown サンプル / Sample markdown files demonstrating features"
Name: "{group}\Third-party Licenses"; Filename: "{app}\assets\THIRD_PARTY_LICENSES.txt"; Comment: "Open-source licenses for bundled libraries (marked / mermaid / KaTeX / highlight.js / Marp / CodeMirror, etc.)"
Name: "{group}\Uninstall {#AppName}"; Filename: "{uninstallexe}"
Name: "{userdesktop}\{#AppName}"; Filename: "{app}\{#AppExeName}"; IconFilename: "{app}\{#AppExeName}"; Tasks: desktopicon

[Tasks]
Name: "desktopicon"; Description: "デスクトップにショートカットを作成 / Create desktop shortcut"; Flags: unchecked
Name: "assoc_md";    Description: ".md / .markdown を {#AppName} に関連付ける / Associate .md & .markdown files"
Name: "ctx_folder";  Description: "フォルダ右クリックメニューに追加 / Add to folder context menu"
Name: "ctx_file";    Description: ".md ファイル右クリックメニューに追加 / Add to .md file context menu"

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

[Run]
Filename: "{app}\{#AppExeName}"; Description: "{#AppName} を起動 / Launch {#AppName}"; Flags: nowait postinstall skipifsilent
Filename: "{win}\explorer.exe"; Parameters: """{app}"""; Description: "インストール先フォルダを開く / Open install folder"; Flags: nowait postinstall skipifsilent unchecked shellexec
Filename: "{app}\assets\THIRD_PARTY_LICENSES.txt"; Description: "サードパーティライセンスを表示 / View third-party licenses"; Flags: nowait postinstall skipifsilent unchecked shellexec
