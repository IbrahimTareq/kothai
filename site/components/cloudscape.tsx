'use client'

// Fractal-noise cloud sky from ForgeUI (https://forgeui.dev/components/cloudscape).
// Colours ease between values via shader uniforms instead of rebuilding the GL context.
import { useEffect, useRef } from 'react'

const vertexShaderGLSL = `
  attribute vec2 position;
  void main() {
    gl_Position = vec4(position, 0.0, 1.0);
  }
`

const fragmentShaderGLSL = `
  precision highp float;
  uniform vec2 u_resolution;
  uniform float u_time;
  uniform vec3 u_colorBottom;
  uniform vec3 u_colorMid;
  uniform vec3 u_colorTop;
  uniform float u_speed;

  float hash(vec2 p) {
    return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453123);
  }

  float noise(vec2 p) {
    vec2 i = floor(p);
    vec2 f = fract(p);
    float a = hash(i);
    float b = hash(i + vec2(1.0, 0.0));
    float c = hash(i + vec2(0.0, 1.0));
    float d = hash(i + vec2(1.0, 1.0));
    vec2 u = f * f * (3.0 - 2.0 * f);
    return mix(a, b, u.x) + (c - a) * u.y * (1.0 - u.x) + (d - b) * u.x * u.y;
  }

  float fbm(vec2 p, float t) {
    float v = 0.0;
    float a = 0.5;
    float fi = 0.0;
    mat2 rot = mat2(0.86, 0.51, -0.51, 0.86);
    for (int i = 0; i < 6; i++) {
      vec2 morph = vec2(sin(t * 0.5 + fi), cos(t * 0.3 - fi)) * 0.05;
      v += a * noise(p + morph);
      p = rot * p * 2.0;
      a *= 0.5;
      fi += 1.0;
    }
    return v;
  }

  void main() {
    vec2 uv = gl_FragCoord.xy / u_resolution;
    float t = u_time * u_speed;
    vec2 aspect = vec2(u_resolution.x / max(u_resolution.y, 1.0), 1.0);
    vec2 p = (uv - 0.5) * aspect;
    vec2 wind = vec2(t * 0.1, t * 0.02);
    float pattern = fbm(p * 2.2 - wind, t);
    float bandLow = smoothstep(0.3, 0.65, pattern);
    float bandHigh = smoothstep(0.7, 0.95, pattern);
    vec3 color = mix(u_colorBottom, u_colorMid, bandLow);
    color = mix(color, u_colorTop, bandHigh);
    gl_FragColor = vec4(color, 1.0);
  }
`

const FADE_MS = 600

function hexToRgb(hex: string): [number, number, number] {
  const h = hex.replace('#', '')
  return [
    Number.parseInt(h.slice(0, 2), 16) / 255,
    Number.parseInt(h.slice(2, 4), 16) / 255,
    Number.parseInt(h.slice(4, 6), 16) / 255,
  ]
}

export interface CloudscapeProps {
  colorBottom: string
  colorMid: string
  colorTop: string
  speed?: number
  className?: string
}

export function Cloudscape({ colorBottom, colorMid, colorTop, speed = 1, className }: CloudscapeProps) {
  const hostRef = useRef<HTMLDivElement | null>(null)
  const canvasRef = useRef<HTMLCanvasElement | null>(null)

  // Read via ref so colour changes ease instead of triggering an effect re-run.
  const colors = useRef({ colorBottom, colorMid, colorTop, speed })
  colors.current = { colorBottom, colorMid, colorTop, speed }

  useEffect(() => {
    const canvas = canvasRef.current
    const host = hostRef.current
    if (!canvas || !host) return

    const gl = canvas.getContext('webgl', { antialias: true, alpha: true })
    if (!gl) return

    const compile = (type: number, source: string) => {
      const shader = gl.createShader(type)
      if (!shader) return null
      gl.shaderSource(shader, source)
      gl.compileShader(shader)
      if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
        console.error('Cloudscape shader compile error:', gl.getShaderInfoLog(shader))
        gl.deleteShader(shader)
        return null
      }
      return shader
    }

    const vertexShader = compile(gl.VERTEX_SHADER, vertexShaderGLSL)
    const fragmentShader = compile(gl.FRAGMENT_SHADER, fragmentShaderGLSL)
    const program = gl.createProgram()
    if (!vertexShader || !fragmentShader || !program) return

    gl.attachShader(program, vertexShader)
    gl.attachShader(program, fragmentShader)
    gl.linkProgram(program)
    if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
      console.error('Cloudscape program link error:', gl.getProgramInfoLog(program))
      return
    }
    gl.useProgram(program)

    const position = gl.getAttribLocation(program, 'position')
    const quad = gl.createBuffer()
    gl.bindBuffer(gl.ARRAY_BUFFER, quad)
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]), gl.STATIC_DRAW)
    gl.enableVertexAttribArray(position)
    gl.vertexAttribPointer(position, 2, gl.FLOAT, false, 0, 0)

    const uResolution = gl.getUniformLocation(program, 'u_resolution')
    const uTime = gl.getUniformLocation(program, 'u_time')
    const uColorBottom = gl.getUniformLocation(program, 'u_colorBottom')
    const uColorMid = gl.getUniformLocation(program, 'u_colorMid')
    const uColorTop = gl.getUniformLocation(program, 'u_colorTop')
    const uSpeed = gl.getUniformLocation(program, 'u_speed')

    const resize = () => {
      // Cap at 2× DPR — six noise octaves per pixel, 3× would waste GPU for no visible gain.
      const dpr = Math.min(window.devicePixelRatio || 1, 2)
      const box = host.getBoundingClientRect()
      canvas.width = Math.max(1, Math.floor(box.width * dpr))
      canvas.height = Math.max(1, Math.floor(box.height * dpr))
      gl.viewport(0, 0, canvas.width, canvas.height)
      gl.uniform2f(uResolution, canvas.width, canvas.height)
    }
    resize()

    const observer = new ResizeObserver(resize)
    observer.observe(host)

    // Seed from props so the first frame is settled (not fading up from black).
    const next = new Float32Array(9)
    const from = new Float32Array(9)
    const target = new Float32Array(9)
    const current = new Float32Array(9)
    let fadeStart = 0

    const readTarget = (out: Float32Array) => {
      const c = colors.current
      out.set(hexToRgb(c.colorBottom), 0)
      out.set(hexToRgb(c.colorMid), 3)
      out.set(hexToRgb(c.colorTop), 6)
    }

    readTarget(target)
    from.set(target)
    current.set(target)

    const start = performance.now()
    let frame = 0

    const render = (now: number) => {
      readTarget(next)
      for (let i = 0; i < 9; i++) {
        if (next[i] !== target[i]) {
          from.set(current)
          target.set(next)
          fadeStart = now
          break
        }
      }

      const t = Math.min(1, (now - fadeStart) / FADE_MS)
      const eased = t * t * (3 - 2 * t) // smoothstep
      for (let i = 0; i < 9; i++) current[i] = from[i] + (target[i] - from[i]) * eased

      gl.uniform1f(uTime, (now - start) / 1000)
      gl.uniform3f(uColorBottom, current[0], current[1], current[2])
      gl.uniform3f(uColorMid, current[3], current[4], current[5])
      gl.uniform3f(uColorTop, current[6], current[7], current[8])
      gl.uniform1f(uSpeed, colors.current.speed ?? 1)
      gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4)
      frame = requestAnimationFrame(render)
    }
    frame = requestAnimationFrame(render)

    return () => {
      cancelAnimationFrame(frame)
      observer.disconnect()
      gl.deleteBuffer(quad)
      gl.deleteProgram(program)
      gl.deleteShader(vertexShader)
      gl.deleteShader(fragmentShader)
    }
  }, [])

  return (
    <div ref={hostRef} className={className} aria-hidden>
      <canvas ref={canvasRef} className="block h-full w-full" />
    </div>
  )
}
