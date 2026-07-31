import { Modal } from '@/components/interior/modal';
import { ChangePasswordForm } from '@/components/pages/change-password-form';
import { useApi } from '@/lib/api';

interface ChangePasswordDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Fired after the password is changed successfully (dialog closes itself). */
  onSuccess: () => void;
}

/**
 * In-app "修改访问密码" modal. The forced first-time flow uses the full-screen
 * the onboarding wizard; this is the voluntary change a logged-in admin triggers
 * from 设置 → 账号安全. Both share ChangePasswordForm, so behaviour is identical.
 */
export function ChangePasswordDialog({ open, onOpenChange, onSuccess }: ChangePasswordDialogProps) {
  const api = useApi();

  return (
    <Modal
      open={open}
      onClose={() => onOpenChange(false)}
      title="修改访问密码"
      description="设置一个全新的强密码后，其它会话将被立即下线，需要重新登录。"
      closeLabel="关闭修改密码弹窗"
    >
      <ChangePasswordForm
        checkStrength={(p) => api.checkPasswordStrength(p)}
        submit={(o, n) => api.changePassword(o, n)}
        onSuccess={() => {
          onSuccess();
          onOpenChange(false);
        }}
        onCancel={() => onOpenChange(false)}
        idPrefix="dialog-cpw"
      />
    </Modal>
  );
}
