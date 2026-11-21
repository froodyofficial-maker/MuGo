; Inno Setup script — builds MuGo-Setup.exe (run by the GitHub Actions workflow)
#define AppVersion GetEnv("MUGO_VERSION")
#if AppVersion == ""
  #define AppVersion "1.0.0"
#endif

[Setup]
AppId={{7E3B6C2A-4D1F-4B8E-9A3C-5F2D1E0B9C77}
AppName=MuGo
AppVersion={#AppVersion}
AppVerName=MuGo {#AppVersion}
AppPublisher=MuGo
DefaultDirName={localappdata}\Programs\MuGo
DisableDirPage=yes
DisableProgramGroupPage=yes
DisableReadyPage=yes
PrivilegesRequired=lowest
OutputDir=..\dist
OutputBaseFilename=MuGo-Setup
SetupIconFile=mugo.ico
UninstallDisplayIcon={app}\MuGo.exe
UninstallDisplayName=MuGo
Compression=lzma2/max
SolidCompression=yes
WizardStyle=modern
CloseApplications=force
RestartApplications=no

[Tasks]
Name: "desktopicon"; Description: "Create a desktop icon"
Name: "startup"; Description: "Start MuGo in the background when I sign in"; Flags: unchecked

[Files]
Source: "..\dist\MuGo\*"; DestDir: "{app}"; Flags: recursesubdirs ignoreversion createallsubdirs

[InstallDelete]
; clear the previous version's files on upgrade (your music library lives elsewhere, in %USERPROFILE%\MuGo)
Type: filesandordirs; Name: "{app}\_internal"

[Icons]
Name: "{autoprograms}\MuGo"; Filename: "{app}\MuGo.exe"
Name: "{autodesktop}\MuGo"; Filename: "{app}\MuGo.exe"; Tasks: desktopicon
Name: "{userstartup}\MuGo"; Filename: "{app}\MuGo.exe"; Parameters: "--no-browser"; Tasks: startup

[Run]
Filename: "{app}\MuGo.exe"; Description: "Open MuGo now"; Flags: nowait postinstall skipifsilent
