/**
 * Root route — redirects to /lobby (설계서/04 §1: lobby가 코어 진입점).
 * 인증 게이트(익명/이메일)는 (auth)/login에서 처리(추후 W1). 여기서는 진입 라우팅만.
 */

import { redirect } from 'next/navigation';

export default function HomePage(): never {
  redirect('/lobby');
}
