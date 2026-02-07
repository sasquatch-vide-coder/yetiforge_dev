import { useState, useEffect } from "react";
import {
  getMfaSetup,
  enableMfa,
  disableMfa,
  changePassword,
  getUsername,
  changeUsername,
} from "../lib/adminApi";
import { useAdminAuth } from "../hooks/useAdminAuth";

interface Props {
  token: string;
}

export function AdminSecurityPanel({ token }: Props) {
  const { mfaEnabled, checkSetupStatus } = useAdminAuth();

  // MFA state
  const [mfaSetup, setMfaSetup] = useState<{
    secret: string;
    qrCode: string;
  } | null>(null);
  const [mfaCode, setMfaCode] = useState("");
  const [mfaLoading, setMfaLoading] = useState(false);
  const [mfaError, setMfaError] = useState("");
  const [mfaSuccess, setMfaSuccess] = useState("");

  // Password state
  const [currentPw, setCurrentPw] = useState("");
  const [newPw, setNewPw] = useState("");
  const [confirmPw, setConfirmPw] = useState("");
  const [pwTouched, setPwTouched] = useState(false);
  const [pwLoading, setPwLoading] = useState(false);
  const [pwError, setPwError] = useState("");
  const [pwSuccess, setPwSuccess] = useState("");

  // Username state
  const [currentUsername, setCurrentUsername] = useState("");
  const [newUsername, setNewUsername] = useState("");
  const [usernameEditing, setUsernameEditing] = useState(false);
  const [usernameLoading, setUsernameLoading] = useState(false);
  const [usernameError, setUsernameError] = useState("");
  const [usernameSuccess, setUsernameSuccess] = useState("");
  const [usernameConfirm, setUsernameConfirm] = useState(false);

  // Fetch current username on mount
  useEffect(() => {
    getUsername(token)
      .then((res) => setCurrentUsername(res.username))
      .catch(() => setCurrentUsername("admin"));
  }, [token]);

  const handleChangeUsername = async () => {
    const trimmed = newUsername.trim();
    if (!trimmed) {
      setUsernameError("Username cannot be empty");
      return;
    }
    if (trimmed.length < 3) {
      setUsernameError("Username must be at least 3 characters");
      return;
    }
    if (trimmed.length > 32) {
      setUsernameError("Username must be 32 characters or fewer");
      return;
    }
    if (!/^[a-zA-Z0-9_.-]+$/.test(trimmed)) {
      setUsernameError("Only letters, numbers, underscores, dots, and hyphens");
      return;
    }
    if (trimmed === currentUsername) {
      setUsernameError("New username is the same as current");
      return;
    }

    if (!usernameConfirm) {
      setUsernameConfirm(true);
      return;
    }

    setUsernameLoading(true);
    setUsernameError("");
    setUsernameSuccess("");
    try {
      const res = await changeUsername(trimmed, token);
      setCurrentUsername(res.username);
      setUsernameSuccess("Username changed successfully");
      setNewUsername("");
      setUsernameEditing(false);
      setUsernameConfirm(false);
    } catch (e) {
      setUsernameError(e instanceof Error ? e.message : "Failed to change username");
      setUsernameConfirm(false);
    } finally {
      setUsernameLoading(false);
    }
  };

  const handleCancelUsernameEdit = () => {
    setUsernameEditing(false);
    setNewUsername("");
    setUsernameError("");
    setUsernameSuccess("");
    setUsernameConfirm(false);
  };

  const handleStartMfaSetup = async () => {
    setMfaLoading(true);
    setMfaError("");
    try {
      const result = await getMfaSetup(token);
      setMfaSetup({ secret: result.secret, qrCode: result.qrCode });
    } catch (e) {
      setMfaError(e instanceof Error ? e.message : "Failed to setup MFA");
    } finally {
      setMfaLoading(false);
    }
  };

  const handleEnableMfa = async () => {
    if (mfaCode.length !== 6) {
      setMfaError("Code must be 6 digits");
      return;
    }
    setMfaLoading(true);
    setMfaError("");
    try {
      await enableMfa(mfaCode, token);
      setMfaSuccess("MFA enabled successfully");
      setMfaSetup(null);
      setMfaCode("");
      await checkSetupStatus();
    } catch (e) {
      setMfaError(e instanceof Error ? e.message : "Failed to enable MFA");
    } finally {
      setMfaLoading(false);
    }
  };

  const handleDisableMfa = async () => {
    setMfaLoading(true);
    setMfaError("");
    try {
      await disableMfa(token);
      setMfaSuccess("MFA disabled");
      await checkSetupStatus();
    } catch (e) {
      setMfaError(e instanceof Error ? e.message : "Failed to disable MFA");
    } finally {
      setMfaLoading(false);
    }
  };

  // Password complexity rules
  const pwRules = [
    { label: "Min 14 characters", test: (pw: string) => pw.length >= 14 },
    { label: "At least 1 uppercase letter", test: (pw: string) => /[A-Z]/.test(pw) },
    { label: "At least 1 lowercase letter", test: (pw: string) => /[a-z]/.test(pw) },
    { label: "At least 1 number", test: (pw: string) => /[0-9]/.test(pw) },
    { label: "At least 1 special character", test: (pw: string) => /[^A-Za-z0-9]/.test(pw) },
  ];
  const allRulesMet = pwRules.every((r) => r.test(newPw));
  const passwordsMatch = newPw === confirmPw && newPw.length > 0;

  const handleChangePassword = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!allRulesMet) {
      setPwError("Password does not meet complexity requirements");
      return;
    }
    if (!passwordsMatch) {
      setPwError("Passwords do not match");
      return;
    }
    setPwLoading(true);
    setPwError("");
    setPwSuccess("");
    try {
      await changePassword(currentPw, newPw, token);
      setPwSuccess("Password changed");
      setCurrentPw("");
      setNewPw("");
      setConfirmPw("");
      setPwTouched(false);
    } catch (e) {
      setPwError(e instanceof Error ? e.message : "Failed to change password");
    } finally {
      setPwLoading(false);
    }
  };

  return (
    <div className="bg-brutal-white brutal-border brutal-shadow p-4">
      <h2 className="text-sm font-bold uppercase mb-2 font-mono">Security</h2>

      {/* MFA Section */}
      <div className="mb-3">
        <h3 className="font-bold uppercase font-mono text-[10px] mb-1.5 text-brutal-black/70">
          Two-Factor Authentication
        </h3>

        <div className="flex items-center justify-between mb-1.5 font-mono">
          <span className="uppercase font-bold text-[10px]">Status</span>
          <span
            className={`px-1.5 py-0.5 font-bold text-[10px] ${
              mfaEnabled
                ? "bg-brutal-green text-brutal-black"
                : "bg-brutal-orange text-brutal-black"
            }`}
          >
            {mfaEnabled ? "ENABLED" : "DISABLED"}
          </span>
        </div>

        {mfaError && (
          <p className="text-brutal-red font-mono text-[10px] mb-1">{mfaError}</p>
        )}
        {mfaSuccess && (
          <p className="text-brutal-green font-mono text-[10px] mb-1 font-bold">
            {mfaSuccess}
          </p>
        )}

        {!mfaEnabled && !mfaSetup && (
          <button
            onClick={handleStartMfaSetup}
            disabled={mfaLoading}
            className="bg-brutal-purple text-brutal-white font-bold uppercase py-1.5 px-3 brutal-border hover:translate-x-[2px] hover:translate-y-[2px] hover:shadow-none brutal-shadow transition-all disabled:opacity-50 text-xs font-mono"
          >
            {mfaLoading ? "Loading..." : "Enable MFA"}
          </button>
        )}

        {mfaSetup && (
          <div className="space-y-2">
            <p className="font-mono text-[10px]">
              Scan this QR code with your authenticator app:
            </p>
            <div className="flex justify-center">
              <img
                src={mfaSetup.qrCode}
                alt="MFA QR Code"
                className="brutal-border max-w-[180px]"
              />
            </div>
            <div className="font-mono text-[10px]">
              <span className="font-bold uppercase">Manual key: </span>
              <code className="bg-brutal-bg px-1 break-all">
                {mfaSetup.secret}
              </code>
            </div>
            <div className="flex gap-2">
              <input
                type="text"
                value={mfaCode}
                onChange={(e) =>
                  setMfaCode(e.target.value.replace(/\D/g, "").slice(0, 6))
                }
                placeholder="6-digit code"
                className="flex-1 brutal-border p-1.5 font-mono text-xs bg-brutal-bg"
              />
              <button
                onClick={handleEnableMfa}
                disabled={mfaLoading || mfaCode.length !== 6}
                className="bg-brutal-green text-brutal-black font-bold uppercase py-1.5 px-3 brutal-border hover:translate-x-[2px] hover:translate-y-[2px] hover:shadow-none brutal-shadow transition-all disabled:opacity-50 text-xs font-mono"
              >
                Verify
              </button>
            </div>
          </div>
        )}

        {mfaEnabled && (
          <button
            onClick={handleDisableMfa}
            disabled={mfaLoading}
            className="bg-brutal-red text-brutal-white font-bold uppercase py-1.5 px-3 brutal-border hover:translate-x-[2px] hover:translate-y-[2px] hover:shadow-none brutal-shadow transition-all disabled:opacity-50 text-xs font-mono"
          >
            {mfaLoading ? "..." : "Disable MFA"}
          </button>
        )}
      </div>

      {/* Change Username */}
      <div className="border-t-2 border-brutal-black/20 pt-2 mt-1">
        <h3 className="font-bold uppercase font-mono text-[10px] mb-1.5 text-brutal-black/70">
          Username
        </h3>

        {usernameError && (
          <p className="text-brutal-red font-mono text-[10px] mb-1">{usernameError}</p>
        )}
        {usernameSuccess && (
          <p className="text-brutal-green font-mono text-[10px] mb-1 font-bold">
            {usernameSuccess}
          </p>
        )}

        <div className="flex items-center justify-between mb-1.5 font-mono">
          <span className="uppercase font-bold text-[10px]">Current</span>
          <span className="px-1.5 py-0.5 font-bold text-[10px] bg-brutal-bg brutal-border">
            {currentUsername || "..."}
          </span>
        </div>

        {!usernameEditing ? (
          <button
            onClick={() => {
              setUsernameEditing(true);
              setUsernameSuccess("");
            }}
            className="w-full bg-brutal-yellow text-brutal-black font-bold uppercase py-1.5 brutal-border hover:translate-x-[2px] hover:translate-y-[2px] hover:shadow-none brutal-shadow transition-all text-xs font-mono"
          >
            Change Username
          </button>
        ) : (
          <div className="space-y-2">
            <input
              type="text"
              value={newUsername}
              onChange={(e) => {
                setNewUsername(e.target.value);
                setUsernameConfirm(false);
                setUsernameError("");
              }}
              placeholder="New username (3-32 chars)"
              className="w-full brutal-border p-1.5 font-mono text-xs bg-brutal-bg"
              maxLength={32}
            />
            {usernameConfirm && (
              <p className="text-brutal-orange font-mono text-[10px] font-bold">
                ⚠ You will need to log in with the new username. Click again to confirm.
              </p>
            )}
            <div className="flex gap-2">
              <button
                onClick={handleChangeUsername}
                disabled={usernameLoading || !newUsername.trim()}
                className={`flex-1 ${
                  usernameConfirm
                    ? "bg-brutal-red text-brutal-white"
                    : "bg-brutal-green text-brutal-black"
                } font-bold uppercase py-1.5 brutal-border hover:translate-x-[2px] hover:translate-y-[2px] hover:shadow-none brutal-shadow transition-all disabled:opacity-50 text-xs font-mono`}
              >
                {usernameLoading
                  ? "Saving..."
                  : usernameConfirm
                  ? "Confirm Change"
                  : "Save"}
              </button>
              <button
                onClick={handleCancelUsernameEdit}
                disabled={usernameLoading}
                className="px-3 bg-brutal-bg text-brutal-black font-bold uppercase py-1.5 brutal-border hover:translate-x-[2px] hover:translate-y-[2px] hover:shadow-none brutal-shadow transition-all disabled:opacity-50 text-xs font-mono"
              >
                Cancel
              </button>
            </div>
          </div>
        )}
      </div>

      {/* Change Password */}
      <div className="border-t-2 border-brutal-black/20 pt-2 mt-1">
        <h3 className="font-bold uppercase font-mono text-[10px] mb-1.5 text-brutal-black/70">Change Password</h3>

        {pwError && (
          <p className="text-brutal-red font-mono text-[10px] mb-1">{pwError}</p>
        )}
        {pwSuccess && (
          <p className="text-brutal-green font-mono text-[10px] mb-1 font-bold">
            {pwSuccess}
          </p>
        )}

        <form onSubmit={handleChangePassword} className="space-y-2">
          <input
            type="password"
            value={currentPw}
            onChange={(e) => setCurrentPw(e.target.value)}
            placeholder="Current password"
            className="w-full brutal-border p-1.5 font-mono text-xs bg-brutal-bg"
          />
          <input
            type="password"
            value={newPw}
            onChange={(e) => setNewPw(e.target.value)}
            placeholder="New password"
            className="w-full brutal-border p-1.5 font-mono text-xs bg-brutal-bg"
          />
          {newPw.length > 0 && (
            <div className="space-y-0.5">
              {pwRules.map((rule, i) => (
                <div key={i} className="font-mono text-[10px] flex items-center gap-1">
                  <span className={rule.test(newPw) ? "text-brutal-green" : "text-brutal-red"}>
                    {rule.test(newPw) ? "✓" : "✗"}
                  </span>
                  <span className={rule.test(newPw) ? "text-brutal-green" : "text-brutal-black/50"}>
                    {rule.label}
                  </span>
                </div>
              ))}
            </div>
          )}
          <input
            type="password"
            value={confirmPw}
            onChange={(e) => {
              setConfirmPw(e.target.value);
              setPwTouched(true);
            }}
            placeholder="Confirm new password"
            className="w-full brutal-border p-1.5 font-mono text-xs bg-brutal-bg"
          />
          {pwTouched && confirmPw.length > 0 && (
            <div className="font-mono text-[10px] font-bold">
              {newPw === confirmPw ? (
                <span className="text-brutal-green">✓ Passwords match</span>
              ) : (
                <span className="text-brutal-red">✗ Passwords do not match</span>
              )}
            </div>
          )}
          <button
            type="submit"
            disabled={pwLoading || !allRulesMet || !passwordsMatch}
            className="w-full bg-brutal-yellow text-brutal-black font-bold uppercase py-1.5 brutal-border hover:translate-x-[2px] hover:translate-y-[2px] hover:shadow-none brutal-shadow transition-all disabled:opacity-50 text-xs font-mono"
          >
            {pwLoading ? "Changing..." : "Change Password"}
          </button>
        </form>
      </div>
    </div>
  );
}
