"""Resolving schema imports from the file system (spec §13.3).

    import ./common (Address)      → common.schema.haus, next to the importing file
    import @haus/money (Money)     → the package directory given for "@haus/money"

Python has no scoped package names, so packages are never searched for: the
application lists its direct schema dependencies, by name, with their
directories (`packages=`). `installed_package` finds the directory of an
installed Python package that ships one, without importing it. Each package
directory holds a manifest, `haus.package.haus`, next to its schema:

    { name: "@haus/money", version: "1.2.0", schema: "money.schema.haus" }

The manifest gives types their identity in every language (`@haus/money@1#Money`).
Files outside a schema package are identified by the nearest `pyproject.toml`
project name and their path (`my-app/schemas/order#Root`).
"""

from __future__ import annotations

import importlib.util
import re
import tomllib
from collections.abc import Iterator, Mapping
from dataclasses import dataclass, field
from functools import cache
from pathlib import Path

from ._parser import Parser
from ._schema_file import ResolvedModule
from ._value import Record, String

MANIFEST = "haus.package.haus"
"""The file name of a schema package's manifest."""
EXTENSION = ".schema.haus"

_NAME = re.compile(r"@[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+")
_SEMVER = re.compile(r"[0-9]+\.[0-9]+\.[0-9]+.*")


@dataclass(frozen=True, slots=True)
class Manifest:
    """A schema package's `haus.package.haus`."""

    name: str
    version: str
    schema: str
    """The package's schema file, relative to the manifest."""
    dir: Path

    @property
    def major(self) -> str:
        return self.version.split(".")[0]


@cache
def read_manifest(path: Path) -> Manifest:
    """Read and check a schema package manifest. Raises `ValueError`."""
    values = Parser(path.read_text("utf-8")).parse_sequence()
    match values:
        case [Record(fields)]:
            pass
        case _:
            raise ValueError(f"{path}: a manifest is one record")

    def text(key: str) -> str:
        match fields.get(key):
            case String(value):
                return value
            case _:
                raise ValueError(f"{path}: the manifest needs a string field {key}")

    manifest = Manifest(text("name"), text("version"), text("schema"), path.parent)
    if not _NAME.fullmatch(manifest.name):
        raise ValueError(f"{path}: name must look like @org/name, found {manifest.name}")
    if not _SEMVER.fullmatch(manifest.version):
        raise ValueError(f"{path}: version must be semver (1.2.0), found {manifest.version}")
    return manifest


def _ancestors(directory: Path) -> Iterator[Path]:
    yield directory
    yield from directory.parents


def _stem(path: Path) -> str:
    return path.as_posix().removesuffix(EXTENSION)


@cache
def _project_name(pyproject: Path) -> str | None:
    try:
        data = tomllib.loads(pyproject.read_text("utf-8"))
    except (OSError, tomllib.TOMLDecodeError):
        return None
    match data:
        case {"project": {"name": str(name)}}:
            return name
        case _:
            return None


def _package_of(file: Path) -> Manifest | None:
    """The manifest of the schema package a file belongs to, if any."""
    return next((read_manifest(m) for d in _ancestors(file.parent) if (m := d / MANIFEST).is_file()), None)


def identify(path: str | Path) -> str:
    """The identity of a schema file (spec §13.3): `@haus/money@1`, `@haus/money@1/extra`, `my-app/schemas/order`."""
    file = Path(path).resolve()
    for d in _ancestors(file.parent):
        if (m := d / MANIFEST).is_file():
            manifest = read_manifest(m)
            base = f"{manifest.name}@{manifest.major}"
            rel = file.relative_to(d)
            return base if rel.as_posix() == manifest.schema else f"{base}/{_stem(rel)}"
        if (p := d / "pyproject.toml").is_file() and (name := _project_name(p)) is not None:
            return f"{name}/{_stem(file.relative_to(d))}"
    # Outside any package: just the file name.
    return _stem(Path(file.name))


def read_module(path: str | Path) -> ResolvedModule:
    """A schema file as a resolved module: its key (absolute path), identity, text and package version."""
    file = Path(path).resolve()
    package = _package_of(file)
    return ResolvedModule(str(file), identify(file), file.read_text("utf-8"), package.version if package else None)


@dataclass(frozen=True, slots=True)
class FileResolver:
    """Finds relative files next to the importing file, and the packages listed in `packages`.

    `packages` maps a package name to its directory (the one with `haus.package.haus`):
    the project's direct schema dependencies (spec §13.3). Nothing else is searched.
    """

    base: Path = field(default_factory=Path.cwd)
    """Where relative imports of a root file without a key resolve from."""
    packages: Mapping[str, Path] = field(default_factory=dict[str, Path])

    def resolve(self, module: str, from_key: str | None) -> ResolvedModule:
        directory = Path(from_key).parent if from_key is not None else self.base
        if module.startswith(("./", "../")):
            file = (directory / (module if module.endswith(EXTENSION) else module + EXTENSION)).resolve()
            if not file.is_file():
                raise FileNotFoundError(f"file not found: {file}")
            return read_module(file)
        package_dir = self.packages.get(module)
        if package_dir is None:
            listed = ", ".join(self.packages) or "none"
            raise LookupError(f"package {module} is not among the packages given to the resolver ({listed})")
        manifest_path = (self.base / package_dir / MANIFEST).resolve()
        if not manifest_path.is_file():
            raise FileNotFoundError(f"no {MANIFEST} in {manifest_path.parent}")
        manifest = read_manifest(manifest_path)
        if manifest.name != module:
            raise ValueError(f"{manifest_path} names the package {manifest.name}, not {module}")
        return read_module(manifest.dir / manifest.schema)


def installed_package(name: str) -> Path:
    """The directory of an installed Python package (e.g. one that ships a schema package), without importing it.

    FileResolver(packages={"@haus/money": installed_package("haus_money")})
    """
    spec = importlib.util.find_spec(name)
    if spec is None:
        raise LookupError(f"no installed Python package {name}")
    if spec.submodule_search_locations:
        return Path(next(iter(spec.submodule_search_locations)))
    if spec.origin is None:
        raise LookupError(f"Python package {name} has no location")
    return Path(spec.origin).parent
