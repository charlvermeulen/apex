import { Injectable, inject, signal } from '@angular/core';
import { HttpClient, HttpErrorResponse, HttpHandlerFn, HttpInterceptorFn, HttpRequest } from '@angular/common/http';
import { catchError } from 'rxjs';
import { Router } from '@angular/router';
import { AuthStore } from './auth.store';

export class ApiError extends Error {
  constructor(public status: number, message: string) { super(message); }
}

// Thin typed HTTP client. Server errors always arrive as {error: string} (apps/api/src/index.ts).
@Injectable({ providedIn: 'root' })
export class ApiService {
  private http = inject(HttpClient);

  get<T>(path: string): Promise<T> { return this.first(this.http.get<T>('/api' + path)); }
  post<T>(path: string, body?: unknown): Promise<T> { return this.first(this.http.post<T>('/api' + path, body)); }
  put<T>(path: string, body?: unknown): Promise<T> { return this.first(this.http.put<T>('/api' + path, body)); }
  patch<T>(path: string, body?: unknown): Promise<T> { return this.first(this.http.patch<T>('/api' + path, body)); }
  del<T>(path: string): Promise<T> { return this.first(this.http.delete<T>('/api' + path)); }

  private first<T>(p: import('rxjs').Observable<T>): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      p.subscribe({
        next: resolve,
        error: (e: HttpErrorResponse) => reject(new ApiError(e.status, e.error?.error || 'Something went wrong on the server.')),
      });
    });
  }
}

// legacy toast (Numera.html:2543): one fixed toast, 2.8s
@Injectable({ providedIn: 'root' })
export class ToastService {
  msg = signal('');
  private timer?: ReturnType<typeof setTimeout>;

  show(m: string) {
    this.msg.set(m);
    clearTimeout(this.timer);
    this.timer = setTimeout(() => this.msg.set(''), 2800);
  }
}

// legacy deny() (Numera.html:2544)
export const deny = () => inject(ToastService).show('You do not have access to this area.');

// 401 outside login/logout = session gone (signed out or server idle timeout): reset and return to /login.
export const apiErrorInterceptor: HttpInterceptorFn = (req: HttpRequest<unknown>, next: HttpHandlerFn) => {
  const router = inject(Router);
  const auth = inject(AuthStore);
  return next(req).pipe(
    catchError((e: HttpErrorResponse) => {
      const authPath = req.url.includes('/auth/login') || req.url.includes('/auth/logout');
      if (e.status === 401 && !authPath) {
        auth.clear();
        const detail: string | undefined = e.error?.error;
        router.navigate(['/login'], detail ? { queryParams: { reason: detail } } : {});
      }
      throw e;
    }),
  );
};
