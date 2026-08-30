; RemoteDesk NSIS installer hooks.
;
; RemoteDesk hosts its own signaling server so that a peer elsewhere on the
; network can find it. Windows Firewall blocks inbound connections to a new
; program by default, so without a rule the host looks unreachable to every
; other machine — with no error on either side to explain why.
;
; The rule is deliberately limited to private and domain networks. On a public
; network (a café, an airport) RemoteDesk stays unreachable from outside, which
; is the behaviour you want there.
;
; The port range matches the scan range in src-tauri/src/signaling.rs: 4000,
; walking up to 4009 when earlier ports are taken.

!macro NSIS_HOOK_POSTINSTALL
  DetailPrint "Allowing RemoteDesk through Windows Firewall on private networks..."
  nsExec::ExecToLog 'netsh advfirewall firewall add rule name="RemoteDesk Signaling" dir=in action=allow protocol=TCP localport=4000-4009 profile=private,domain description="Lets other machines on your network reach this RemoteDesk host."'
  Pop $0
  ${If} $0 != 0
    DetailPrint "Could not add the firewall rule automatically. Other machines may be unable to connect until you allow RemoteDesk through Windows Firewall."
  ${EndIf}
!macroend

!macro NSIS_HOOK_POSTUNINSTALL
  DetailPrint "Removing the RemoteDesk firewall rule..."
  nsExec::ExecToLog 'netsh advfirewall firewall delete rule name="RemoteDesk Signaling"'
  Pop $0
!macroend
