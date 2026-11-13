import math, sys
def bez(p,t):
    u=1-t
    return tuple(u**3*p[0][i]+3*u*u*t*p[1][i]+3*u*t*t*p[2][i]+t**3*p[3][i] for i in (0,1))
def dbez(p,t):
    u=1-t
    return tuple(3*u*u*(p[1][i]-p[0][i])+6*u*t*(p[2][i]-p[1][i])+3*t*t*(p[3][i]-p[2][i]) for i in (0,1))
# المسار: من سن الدبوس لفوق، منحنى S
segs=[[(256,480),(256,392),(300,352),(292,296)],[(292,296),(284,246),(244,240),(256,190)]]
W0,W1=104,14
N=60
pts=[];L=len(segs)
for si,s in enumerate(segs):
    for k in range(N+ (1 if si==L-1 else 0)):
        t=k/N; g=(si+t)/L
        x,y=bez(s,t); dx,dy=dbez(s,t); n=math.hypot(dx,dy); nx,ny=-dy/n,dx/n
        w=(W0+(W1-W0)*g**0.8)/2
        pts.append((x,y,nx,ny,w,g))
left=[(x+nx*w,y+ny*w) for x,y,nx,ny,w,g in pts]
right=[(x-nx*w,y-ny*w) for x,y,nx,ny,w,g in pts]
poly=left+right[::-1]
road="M"+" L".join(f"{x:.1f} {y:.1f}" for x,y in poly)+"Z"
# خطوط الطريق المتقطعة (بتصغر مع البعد)
dashes=[]
i=0
gaps=[(0.06,0.13),(0.22,0.28),(0.36,0.41),(0.49,0.53),(0.60,0.63),(0.70,0.72)]
for a,b in gaps:
    seg=[p for p in pts if a<=p[5]<=b]
    if len(seg)<2: continue
    w=max(2.5,seg[0][4]*0.16)
    d="M"+" L".join(f"{x:.1f} {y:.1f}" for x,y,*_ in seg)
    dashes.append(f'<path d="{d}" stroke="FG" stroke-width="{w:.1f}" stroke-linecap="round" fill="none"/>')
pin="M256 452C256 452 116 304 116 206a140 140 0 0 1 280 0c0 98-140 246-140 246Z"
def icon(bg,fg,rounded=True):
    r='rx="116"' if rounded else ''
    return f'''<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512">
  <defs><clipPath id="pin"><path d="{pin}"/></clipPath></defs>
  <rect width="512" height="512" {r} fill="{bg}"/>
  <path d="{pin}" fill="{fg}"/>
  <g clip-path="url(#pin)">
    <path d="{road}" fill="{bg}"/>
    {"".join(dashes).replace("FG",fg)}
  </g>
  <circle cx="256" cy="178" r="26" fill="{bg}"/>
</svg>
'''
open("icon-black.svg","w").write(icon("#000","#fff"))
open("icon-white.svg","w").write(icon("#fff","#000"))
open("_mark_paths.txt","w").write(pin+"\n"+road+"\n"+"\n".join(dashes))
